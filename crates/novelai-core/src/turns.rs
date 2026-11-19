// One NovelAI request at a time, at least `MIN_INTERVAL` apart, across every
// process on this computer that uses this crate (the app and
// cutting-room-mcp.exe).
//
// NovelAI runs one generation at a time per account; a second request sent
// while one is running gets a 429. Each process keeps its own clock
// (`LAST_GENERATION`), and a lock file in the temp folder holds the time of
// the last request any process made. A request holds the file's lock from
// its wait until it has finished, so no two overlap.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::is_cancelled;

/// Minimum gap between the end of one request and the start of the next.
pub(crate) const MIN_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) static LAST_GENERATION: Mutex<Option<Instant>> = Mutex::new(None);

/// Waits before retrying a request NovelAI rate-limited (429), then gives up.
pub(crate) const RATE_LIMIT_RETRIES: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(30)];
pub(crate) const RATE_LIMITED: &str = "NovelAI is rate-limiting requests. Wait a moment and try again.";

fn lock_path() -> PathBuf {
    std::env::temp_dir().join("cutting-room-novelai.lock")
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The right to send one request. Dropping it without `finish` (an error
/// before sending) still releases the lock.
pub(crate) struct Turn {
    file: Option<File>,
}

impl Turn {
    /// Records that a request just ended, for this process and the others.
    pub(crate) fn finish(mut self) {
        *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
        if let Some(f) = self.file.as_mut() {
            let _ = f.set_len(0);
            let _ = f.seek(SeekFrom::Start(0));
            let _ = f.write_all(now_millis().to_string().as_bytes());
            let _ = f.flush();
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if let Some(f) = self.file.take() {
            let _ = f.unlock();
        }
    }
}

fn open_lock_file() -> Option<File> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path()).ok()
}

/// How long until the gap since the last request (in any process) has passed.
fn remaining(file: Option<&mut File>) -> Duration {
    let local = LAST_GENERATION
        .lock()
        .unwrap()
        .map(|t| MIN_INTERVAL.saturating_sub(t.elapsed()))
        .unwrap_or(Duration::ZERO);
    let shared = file
        .and_then(|f| {
            let mut s = String::new();
            f.seek(SeekFrom::Start(0)).ok()?;
            f.read_to_string(&mut s).ok()?;
            s.trim().parse::<u64>().ok()
        })
        .map(|last| {
            let since = Duration::from_millis(now_millis().saturating_sub(last));
            MIN_INTERVAL.saturating_sub(since)
        })
        .unwrap_or(Duration::ZERO);
    local.max(shared)
}

/// Waits for this process's turn and the shared lock. None if the run was
/// cancelled while waiting.
pub(crate) async fn wait_for_turn(run_id: &str) -> Option<Turn> {
    loop {
        if is_cancelled(run_id) {
            return None;
        }
        // If the temp folder can't be used, fall back to this process's own
        // spacing rather than refusing to work.
        let mut file = open_lock_file();
        let locked = match file.as_ref() {
            Some(f) => f.try_lock().is_ok(),
            None => true,
        };
        if locked {
            let wait = remaining(file.as_mut());
            if wait.is_zero() {
                return Some(Turn { file });
            }
            if let Some(f) = file.take() {
                let _ = f.unlock();
            }
            // Short naps so a cancel during the wait takes effect promptly.
            tokio::time::sleep(wait.min(Duration::from_millis(100))).await;
        } else {
            // Another process is mid-request.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Sleeps for `d`, waking early if the run is cancelled. False if cancelled.
pub(crate) async fn pause(run_id: &str, d: Duration) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if is_cancelled(run_id) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    !is_cancelled(run_id)
}

/// Runs `send` in its turn. A 429 is retried after 10 s and then 30 s before
/// giving up; nothing else is retried (a 400, 401 or 402 won't change).
/// Ok(None) means the run was cancelled.
pub(crate) async fn send_in_turn<T, F, Fut>(run_id: &str, mut send: F) -> Result<Option<T>, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut retries = RATE_LIMIT_RETRIES.iter();
    loop {
        let Some(turn) = wait_for_turn(run_id).await else { return Ok(None) };
        let result = send().await;
        turn.finish();
        match result {
            Err(e) if e == RATE_LIMITED => match retries.next() {
                Some(&wait) => {
                    if !pause(run_id, wait).await {
                        return Ok(None);
                    }
                }
                None => {
                    return Err("NovelAI kept rate-limiting requests (after waiting 10 and 30 seconds), \
                                so this stopped."
                        .into())
                }
            },
            other => return other.map(Some),
        }
    }
}
