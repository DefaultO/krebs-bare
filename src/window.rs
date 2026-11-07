//! Lines for the server's window. The window can stall, as a Windows console does while text is selected in it, and it can
//! be gone, as a pipe to a program that ended is. `println!` would then block or panic, so one thread does the writing and
//! everyone else only hands it lines: neither can reach a request or the lobby lock. Past `WAITING` lines the rest are dropped.

use std::io::Write;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::OnceLock;

const WAITING: usize = 64;

enum Line {
    Out(String),
    Err(String),
}

fn writer() -> Option<&'static SyncSender<Line>> {
    static SENDER: OnceLock<Option<SyncSender<Line>>> = OnceLock::new();
    SENDER
        .get_or_init(|| {
            let (sender, lines) = sync_channel(WAITING);
            let writes = move || {
                for line in lines {
                    // what cannot be shown is lost, and nothing here depends on it
                    let _ = match line {
                        Line::Out(text) => writeln!(std::io::stdout(), "{text}"),
                        Line::Err(text) => writeln!(std::io::stderr(), "{text}"),
                    };
                }
            };
            std::thread::Builder::new().name("window".into()).spawn(writes).ok().map(|_| sender)
        })
        .as_ref()
}

fn hand_over(line: Line) {
    if let Some(writer) = writer() {
        let _ = writer.try_send(line);
    }
}

/// A line for whoever runs this server.
pub(crate) fn say(text: String) {
    hand_over(Line::Out(text));
}

/// A line about something that went wrong.
pub(crate) fn warn(text: String) {
    hand_over(Line::Err(text));
}
