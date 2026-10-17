//! Cutting Room's MCP server: lets an MCP client (Claude Code, Claude
//! Desktop, or others) generate images through the user's NovelAI account.
//!
//! Usage: cutting-room-mcp [--output-dir <folder>]
//!
//! It speaks MCP over stdin/stdout, so stdout carries nothing but protocol
//! messages; diagnostics go to stderr.

mod protocol;
mod tools;
mod windows;

use protocol::{handle_line, ServerInfo};
use std::io::{BufRead, Write};
use tools::NovelAiTools;

const INFO: ServerInfo = ServerInfo {
    name: "cutting-room-novelai",
    version: env!("CARGO_PKG_VERSION"),
    instructions: "Generates images through the user's NovelAI account using Cutting Room's saved login. \
        Every generation needs the user's approval in a Windows dialog and may be declined. \
        Use a fixed seed when comparing prompt variations.",
};

fn output_dir() -> Result<String, String> {
    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--output-dir") {
        Some(i) => args.get(i + 1).cloned().ok_or("--output-dir needs a folder path".to_string()),
        None => {
            let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE isn't set".to_string())?;
            Ok(format!("{home}\\Pictures\\Cutting Room MCP"))
        }
    }
}

fn main() {
    let output_dir = match output_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("cutting-room-mcp: {e}");
            std::process::exit(2);
        }
    };
    eprintln!("cutting-room-mcp: saving images to {output_dir}");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("couldn't start the async runtime");
    let mut tools = NovelAiTools {
        output_dir,
        runtime,
        paused: None,
        approve: windows::ask_approval,
        timestamp: windows::local_timestamp,
    };

    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&mut tools, &INFO, &line) {
            let mut out = stdout.lock();
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break; // client went away
            }
        }
    }
}
