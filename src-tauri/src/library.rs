// The user's library: small JSON files (tag associations, saved prompts, the
// artist library, workflow plans) kept in the character card folder, and the
// text files of a wildcards folder. Names are checked so nothing can be read
// or written outside the folder the user chose.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Subfolders library files may live in ("" is the folder itself).
const SUBFOLDERS: [&str; 4] = ["", "prompts", "plans", "artists"];

fn check_name(name: &str) -> Result<(), String> {
    let ok = name.ends_with(".json")
        && name.len() <= 120
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || " -_.()".contains(c));
    if ok {
        Ok(())
    } else {
        Err(format!("\"{name}\" isn't a usable library file name."))
    }
}

fn library_path(folder: &str, sub: &str, name: &str) -> Result<PathBuf, String> {
    if !SUBFOLDERS.contains(&sub) {
        return Err(format!("Unknown library folder: {sub}"));
    }
    check_name(name)?;
    let base = Path::new(folder);
    if !base.is_dir() {
        return Err("The library folder doesn't exist.".into());
    }
    Ok(if sub.is_empty() { base.join(name) } else { base.join(sub).join(name) })
}

/// A library file's JSON, or null when it doesn't exist yet.
pub fn read(folder: &str, sub: &str, name: &str) -> Result<Value, String> {
    let path = library_path(folder, sub, name)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("{} is damaged: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("couldn't read {}: {e}", path.display())),
    }
}

/// Writes through a temporary file, so a crash never leaves half a file.
pub fn write(folder: &str, sub: &str, name: &str, value: &Value) -> Result<String, String> {
    let path = library_path(folder, sub, name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The .json files in a library subfolder, by name.
pub fn list(folder: &str, sub: &str) -> Result<Vec<String>, String> {
    if !SUBFOLDERS.contains(&sub) {
        return Err(format!("Unknown library folder: {sub}"));
    }
    let dir = if sub.is_empty() { PathBuf::from(folder) } else { Path::new(folder).join(sub) };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| check_name(n).is_ok())
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WildcardFile {
    pub path: String,
    /// The path inside the folder, with forward slashes and no ".txt".
    pub relative: String,
}

/// Every .txt file in `dir` and its subfolders (at most 8 deep and 5,000 files).
pub fn list_wildcards(dir: &str) -> Result<Vec<WildcardFile>, String> {
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(format!("{dir} isn't a folder."));
    }
    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() && depth < 8 {
                stack.push((p, depth + 1));
            } else if kind.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("txt")) {
                let rel = p.strip_prefix(&root).unwrap_or(&p).with_extension("");
                let relative = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                out.push(WildcardFile { path: p.to_string_lossy().into_owned(), relative });
                if out.len() >= 5000 {
                    return Ok(out);
                }
            }
        }
    }
    out.sort_by_key(|f| f.relative.to_lowercase());
    Ok(out)
}

/// Saves an edited prompt file. Only an existing .txt file is written, through
/// a temporary file, keeping Windows line endings.
pub fn write_prompt_file(path: &str, lines: &[String]) -> Result<(), String> {
    let p = Path::new(path);
    if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("txt")) || !p.is_file() {
        return Err("Only an existing .txt prompt file can be saved.".into());
    }
    if lines.iter().any(|l| l.contains('\n') || l.contains('\r')) {
        return Err("A line can't contain a line break.".into());
    }
    let mut text = lines.join("\r\n");
    text.push_str("\r\n");
    let tmp = p.with_extension("txt.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("couldn't save {path}: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("couldn't save {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_names_that_leave_the_folder() {
        for bad in ["../x.json", "a/b.json", r"a\b.json", "x.txt", ".hidden.json", "C:x.json"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
        assert!(check_name("associations.json").is_ok());
        assert!(check_name("Beach day (v2).json").is_ok());
        assert!(library_path(".", "../etc", "a.json").is_err());
    }

    #[test]
    fn writes_reads_and_lists() {
        let dir = std::env::temp_dir().join(format!("cr-library-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let folder = dir.to_string_lossy().into_owned();
        assert_eq!(read(&folder, "prompts", "a.json").unwrap(), Value::Null);
        write(&folder, "prompts", "a.json", &serde_json::json!({"x": 1})).unwrap();
        assert_eq!(read(&folder, "prompts", "a.json").unwrap()["x"], 1);
        assert_eq!(list(&folder, "prompts").unwrap(), vec!["a.json"]);

        std::fs::create_dir_all(dir.join("wild").join("outfits")).unwrap();
        std::fs::write(dir.join("wild").join("hair.txt"), "red").unwrap();
        std::fs::write(dir.join("wild").join("outfits").join("Summer.txt"), "a").unwrap();
        let w = list_wildcards(&dir.join("wild").to_string_lossy()).unwrap();
        let rel: Vec<_> = w.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(rel, vec!["hair", "outfits/Summer"]);
        let hair = dir.join("wild").join("hair.txt");
        write_prompt_file(&hair.to_string_lossy(), &["red".into(), "%3 blue".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(&hair).unwrap(), "red\r\n%3 blue\r\n");
        assert!(write_prompt_file(&dir.join("nope.txt").to_string_lossy(), &[]).is_err());
        assert!(write_prompt_file(&hair.to_string_lossy(), &["a\nb".into()]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
