//! One match's own server: a `krebs serve` child process with a world made for that match, driven over its HTTP API.
//! `child.pid` in a match's folder names the running child: a child outlives a server that is killed, so the next start
//! ends whatever those files still name.
//!
//! A child listens on this PC only, but any program here or any web page in a browser here can find its port. So every
//! call needs a secret made for that match, its server password, and it has no admin console. Past that password
//! `/api/version` says how many have placed a spawn, `/assets/map` is terrain the players already have, and `/socket` gives
//! nothing to a connection with no token, and only a sign-in makes one.
//!
//! What goes between a server and its child goes through the pipes between them and never through the match's folder,
//! which on some PCs other accounts can write to: the secret goes down the child's stdin, and the port comes back up its
//! stdout, with the rest of what it prints going on to `server.log`. Nothing else can stand in for either. The child waits
//! for the secret before it does anything, which is also the moment it goes under its memory limit (`job`).

use crate::job::Job;
use crate::window;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::thread::JoinHandle;
use std::time::Duration;
use util::json::Json;

const PID_FILE: &str = "child.pid";
/// What a child with `--announce-port` puts before its port, on a line of its own. It takes any free one and says so, as a
/// port picked here for it to use could be taken in between, and whatever took it would be sent the secret.
const PORT_LINE: &[u8] = b"krebs-port ";
/// How long a child gets to come up, with its world to load.
const START_TIME: Duration = Duration::from_secs(120);
/// On this PC alone, on any free port, with no admin console and no Steam sign-in.
const CHILD_FLAGS: [&str; 14] = ["--host", "127.0.0.1", "--port", "0", "--cli-port", "0", "--steam", "off", "--tick-rate", "50", "--mods", "devtools,matchrun", "--password-stdin", "--announce-port"];
const SECRET_BYTES: usize = 32;
const ROOMS_PER_SECTOR: u32 = 72;
const ROOMS_PER_PLAYER: u32 = 12;
const SPAWN_NAME: &str = "Spawn1";
/// The most any bot can use in one tick, however full its bucket. Its own limit is `mods/matchrun`'s.
const CPU_MAX_PER_TICK: f64 = 300.0;
/// A match has a few VMs and wants speed: a young generation that holds a whole tick (`host::create_params`), and with
/// `runner.setupList` Game setup's object list. What either shows to a bot: ARCHITECTURE.md "What differs in a match".
const SEMI_SPACE_MB: f64 = 16.0;

/// Never: a checkpoint would leave the players' code on disk, and a match that dies is not resumed.
const NO_CHECKPOINTS_S: f64 = 31_536_000.0;

/// What players need of the map to pick a room and place a spawn. Nothing here changes during a match.
pub(crate) struct Map {
    pub rooms: Vec<String>,
    /// Rooms with a controller, the only ones a player can start in.
    pub claimable: BTreeSet<String>,
    pub terrain: BTreeMap<String, String>,
    /// Controllers, sources, minerals and keeper lairs: (type, x, y, and a mineral's type).
    pub objects: BTreeMap<String, Vec<(String, i32, i32, Option<String>)>>,
}

/// How to reach a running world, which is cheap to copy out of the lobby lock.
#[derive(Clone)]
pub(crate) struct Link {
    port: u16,
    /// The match's server password.
    secret: String,
}

#[cfg(test)]
impl Link {
    pub(crate) fn nowhere() -> Link {
        Link { port: 0, secret: String::new() }
    }
}

pub(crate) struct World {
    process: Child,
    dir: PathBuf,
    pub link: Link,
    /// None only until the child is under it.
    job: Option<Job>,
    /// Takes what the child prints, until it ends.
    printing: Option<JoinHandle<()>>,
}

/// The map's side in sectors, for this many players.
pub(crate) fn sectors_for(players: u32) -> u32 {
    let wanted = (players * ROOMS_PER_PLAYER).div_ceil(ROOMS_PER_SECTOR) as f64;
    (wanted.sqrt().ceil() as u32).max(1)
}

fn collection<'a>(db: &'a Json, name: &str) -> impl Iterator<Item = &'a Json> {
    let found = match db.get("collections") {
        Some(Json::Arr(all)) => all.iter().find(|c| c.get("name").and_then(Json::as_str) == Some(name)).and_then(|c| c.get("data")),
        _ => None,
    };
    let items: &[Json] = match found {
        Some(Json::Arr(items)) => items,
        _ => &[],
    };
    items.iter()
}

fn read_objects(db: &Json) -> BTreeMap<String, Vec<(String, i32, i32, Option<String>)>> {
    let mut objects: BTreeMap<String, Vec<(String, i32, i32, Option<String>)>> = BTreeMap::new();
    for o in collection(db, "rooms.objects") {
        let (Some(kind), Some(room), Some(x), Some(y)) = (o.get("type").and_then(Json::as_str), o.get("room").and_then(Json::as_str), o.get("x").and_then(Json::as_f64), o.get("y").and_then(Json::as_f64)) else { continue };
        if matches!(kind, "controller" | "source" | "mineral" | "keeperLair") {
            let mineral = o.get("mineralType").and_then(Json::as_str).map(str::to_string);
            objects.entry(room.to_string()).or_default().push((kind.to_string(), x as i32, y as i32, mineral));
        }
    }
    objects
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    util::sys::os_random(&mut raw);
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

fn run(exe: &Path, what: &str, dir: &Path, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let out = Command::new(exe).args(args).current_dir(dir).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr)))
}

/// A match's own `krebs.json`, which holds nothing secret and nothing that keeps anyone out: on some PCs others can change
/// it, so what does that is in `CHILD_FLAGS`, which go before any file.
fn child_config() -> Json {
    backend::http::obj(vec![
        ("cli", backend::http::obj(vec![("off", Json::Bool(true))])),
        ("persist", backend::http::obj(vec![("intervalS", Json::Num(NO_CHECKPOINTS_S))])),
        ("engine", backend::http::obj(vec![("cpuMaxPerTick", Json::Num(CPU_MAX_PER_TICK))])),
        ("runner", backend::http::obj(vec![("semiSpaceMb", Json::Num(SEMI_SPACE_MB)), ("setupList", Json::Bool(true))])),
    ])
}

/// The port in a line a child printed, if that is what it is.
fn announced(line: &[u8]) -> Option<u16> {
    std::str::from_utf8(line.strip_prefix(PORT_LINE)?).ok()?.trim().parse().ok()
}

/// Sends on the port a child announces, once, and writes everything else it prints to `log`, until it ends.
fn follow(printed: ChildStdout, mut log: File, port: Sender<u16>) {
    let mut lines = BufReader::new(printed);
    let mut line = Vec::new();
    while lines.read_until(b'\n', &mut line).is_ok_and(|read| read > 0) {
        if let Some(found) = announced(&line) {
            let _ = port.send(found);
            break;
        }
        let _ = log.write_all(&line);
        line.clear();
    }
    let _ = std::io::copy(&mut lines, &mut log);
}

impl World {
    /// Generates a world in `dir` and serves it at 50 ms a tick, on no more than `memory` bytes: a paused world would apply
    /// commands but never publish them, so accounts made while it was paused could not sign in, and ticks cost nothing before
    /// anyone has a bot.
    pub fn start(dir: &Path, sectors: u32, seed: u64, memory: u64) -> Result<(World, Map), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // the child runs in `dir`, and `--data` is relative when the server's is
        let dir = std::path::absolute(dir).map_err(|e| e.to_string())?;
        let data = dir.join("world");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let size = format!("{sectors}x{sectors}");
        let seed = seed.to_string();
        let os = |s: &'static str| std::ffi::OsStr::new(s);
        run(&exe, "world generation", &dir, &[os("new"), os("--world"), size.as_ref(), os("--seed"), seed.as_ref(), os("--data"), data.as_ref()])?;
        let export = dir.join("map.json");
        run(&exe, "reading the map", &dir, &[os("export"), export.as_ref(), os("--data"), data.as_ref()])?;
        let db = Json::parse(&std::fs::read_to_string(&export).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&export);
        let objects = read_objects(&db);
        let mut rooms: Vec<String> = collection(&db, "rooms").filter_map(|r| r.get("_id").and_then(Json::as_str).map(str::to_string)).collect();
        rooms.sort();
        let claimable = objects.iter().filter(|(_, list)| list.iter().any(|(kind, ..)| kind == "controller")).map(|(room, _)| room.clone()).collect();

        let config = dir.join("krebs.json");
        std::fs::write(&config, child_config().stringify()).map_err(|e| e.to_string())?;
        let log = File::create(dir.join("server.log")).map_err(|e| e.to_string())?;
        let mut process = Command::new(&exe)
            .arg("serve")
            .arg("--config")
            .arg(&config)
            .arg("--data")
            .arg(&data)
            .args(CHILD_FLAGS)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log.try_clone().map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|e| e.to_string())?;
        let (Some(mut password), Some(printed)) = (process.stdin.take(), process.stdout.take()) else { return Err("the match server has no pipes".into()) };
        let (told, port) = channel();
        let printing = std::thread::Builder::new().name("match output".into()).spawn(move || follow(printed, log, told)).map_err(|e| e.to_string())?;
        let secret = random_hex(SECRET_BYTES);
        let mut world = World { process, dir, link: Link { port: 0, secret }, job: None, printing: Some(printing) };
        std::fs::write(world.dir.join(PID_FILE), world.process.id().to_string()).map_err(|e| e.to_string())?;
        // it waits for the password, so it does this under the limit and before anything of a bot's can run
        world.job = Some(Job::limit(&world.process, memory).map_err(|e| format!("the memory limit could not be set: {e}"))?);
        password.write_all(format!("{}\n", world.link.secret).as_bytes()).map_err(|_| "the match server did not start")?;
        drop(password);
        // with the child gone this comes back at once, as `follow` lets go of the sender
        world.link.port = port.recv_timeout(START_TIME).map_err(|_| "the match server did not start")?;
        let terrain = world.link.terrain(&rooms)?;
        Ok((world, Map { rooms, claimable, terrain, objects }))
    }

    /// Whether the child has gone, which no retry can change.
    pub fn exited(&mut self) -> bool {
        matches!(self.process.try_wait(), Ok(Some(_)))
    }

    /// Whether the child has asked for more memory than its limit.
    pub fn over_memory(&mut self) -> bool {
        self.job.as_mut().is_some_and(Job::over_limit)
    }

    fn stop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        // `server.log` is open until this has seen the end of the child's output
        if let Some(printing) = self.printing.take() {
            let _ = printing.join();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Link {
    /// `method path` on the world's API, parsed.
    fn http(&self, method: &str, path: &str, body: Option<&str>, token: Option<&str>) -> Result<Json, String> {
        Json::parse(&self.text(method, path, body, token)?).map_err(|e| format!("{path}: {e}"))
    }

    /// `method path` on the world's API, as it came.
    fn text(&self, method: &str, path: &str, body: Option<&str>, token: Option<&str>) -> Result<String, String> {
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
        let body = body.unwrap_or("");
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Server-Password: {}\r\n", self.secret);
        if let Some(t) = token {
            req += &format!("X-Token: {t}\r\nX-Username: x\r\n");
        }
        if method == "POST" {
            req += &format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len());
        }
        req += "\r\n";
        req += body;
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (_, rest) = text.split_once("\r\n\r\n").ok_or("malformed response")?;
        Ok(rest.to_string())
    }

    fn checked(reply: Json) -> Result<Json, String> {
        match reply.get("error").and_then(Json::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(reply),
        }
    }

    fn control(&self, body: &str) -> Result<(), String> {
        Self::checked(self.http("POST", "/api/dev/control", Some(body), None)?).map(|_| ())
    }

    /// Plays exactly `ticks` more ticks, as fast as the bots allow, then stops there.
    pub fn play_exactly(&self, ticks: u64) -> Result<(), String> {
        self.control(r#"{"action":"speed","ms":0}"#)?;
        self.control(r#"{"action":"pause"}"#)?;
        self.control(&format!(r#"{{"action":"runFor","n":{ticks}}}"#))
    }

    /// What `mods/matchrun` reports for watching the run.
    pub fn view(&self) -> Result<Json, String> {
        Self::checked(self.http("GET", "/api/matchrun/view", None, None)?)
    }

    /// What is in these rooms (`W1N1,W2N1`). Only the page reads it, so it stays text.
    pub fn rooms(&self, names: &str) -> Result<String, String> {
        self.text("GET", &format!("/api/matchrun/rooms?rooms={names}"), None, None)
    }

    pub fn time(&self) -> Result<u64, String> {
        Ok(self.http("GET", "/api/game/time", None, None)?.get("time").and_then(Json::as_f64).unwrap_or(0.0) as u64)
    }

    fn terrain(&self, rooms: &[String]) -> Result<BTreeMap<String, String>, String> {
        let list = Json::Arr(rooms.iter().map(|r| Json::Str(r.clone())).collect());
        let body = backend::http::obj(vec![("rooms", list)]).stringify();
        let reply = self.http("POST", "/api/game/rooms", Some(&body), None)?;
        let docs = reply.get("rooms").and_then(Json::as_array).ok_or("no terrain in the reply")?;
        Ok(docs.iter().filter_map(|d| Some((d.get("room")?.as_str()?.to_string(), d.get("terrain")?.as_str()?.to_string()))).collect())
    }

    /// An account in this world only. Nobody gets its credentials, so nobody can reach in.
    pub fn create_account(&self, name: &str, password: &str) -> Result<(), String> {
        let body = backend::http::obj(vec![("username", Json::Str(name.into())), ("email", Json::Str(format!("{name}@match.invalid"))), ("password", Json::Str(password.into()))]);
        Self::checked(self.http("POST", "/api/register/submit", Some(&body.stringify()), None)?).map(|_| ())
    }

    fn sign_in(&self, name: &str, password: &str) -> Result<String, String> {
        let body = backend::http::obj(vec![("email", Json::Str(name.into())), ("password", Json::Str(password.into()))]).stringify();
        let reply = Self::checked(self.http("POST", "/api/auth/signin", Some(&body), None)?)?;
        reply.get("token").and_then(Json::as_str).map(str::to_string).ok_or_else(|| "no token".to_string())
    }

    /// The world's own answer, so anything it refuses is refused here too.
    pub fn place_spawn(&self, name: &str, password: &str, room: &str, x: i32, y: i32) -> Result<(), String> {
        let token = self.sign_in(name, password)?;
        let body = backend::http::obj(vec![("room", Json::Str(room.into())), ("x", Json::Num(x.into())), ("y", Json::Num(y.into())), ("name", Json::Str(SPAWN_NAME.into()))]);
        Self::checked(self.http("POST", "/api/game/place-spawn", Some(&body.stringify()), Some(&token))?).map(|_| ())
    }

    pub fn upload(&self, name: &str, password: &str, modules: &Json) -> Result<(), String> {
        let token = self.sign_in(name, password)?;
        let body = backend::http::obj(vec![("branch", Json::Str("default".into())), ("modules", modules.clone())]);
        Self::checked(self.http("POST", "/api/user/code", Some(&body.stringify()), Some(&token))?).map(|_| ())
    }
}

// ---- children left behind ----

/// The folder after `--data` in a command line, which is quoted if it holds a space.
fn data_of(command_line: &str) -> Option<&str> {
    let rest = command_line.split_once(" --data ")?.1.trim_start();
    Some(match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?,
        None => rest.split(" --").next()?.trim_end(),
    })
}

/// A pid file can outlive its process, and after a reboot the number can belong to anything, so nothing is killed on the
/// number alone. The whole folder has to match: a copy of a running server's folder holds that server's `child.pid`, and
/// any relative path of it is part of that child's command line too. A child is always started with its absolute path.
fn is_child_of(command_line: &str, folder: &Path) -> bool {
    let Ok(folder) = std::path::absolute(folder) else { return false };
    let world = folder.join("world");
    // Windows does not mind the case of a path, and the data folder can be named differently from one start to the next
    let same = |a: &str, b: &str| if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b };
    command_line.contains(" serve ") && data_of(command_line).is_some_and(|data| same(data, &world.to_string_lossy()))
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let powershell = backend::steam_web::system_program(r"WindowsPowerShell\v1.0\powershell");
    let out = Command::new(powershell).args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string()).filter(|s| !s.trim().is_empty())
}

#[cfg(not(windows))]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string()).filter(|s| !s.trim().is_empty())
}

#[cfg(windows)]
fn kill(pid: u32) {
    let _ = Command::new(backend::steam_web::system_program("taskkill")).args(["/PID", &pid.to_string(), "/F"]).output();
}

#[cfg(not(windows))]
fn kill(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}

/// Whether `data\bare\matches` leads somewhere other than where it says. std counts a junction as a symlink. A cloud
/// drive's placeholder is a reparse point too, but no link, and Documents is often on one, so what only stands for itself
/// is fine. The data folder is the host's to place, so the two steps below it are what is looked at.
pub(crate) fn redirected(matches: &Path) -> bool {
    matches.ancestors().take(2).any(|step| std::fs::symlink_metadata(step).is_ok_and(|found| found.file_type().is_symlink()))
}

/// Match folders are named by the lobby's number, so nothing else here is one of ours.
fn is_match_folder(folder: &Path) -> bool {
    let name = folder.file_name().and_then(|n| n.to_str()).unwrap_or("");
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) && std::fs::symlink_metadata(folder).is_ok_and(|found| found.is_dir())
}

/// Ends the worlds a previous server left running and clears their folders: lobbies live in memory, so those are lost.
pub(crate) fn sweep(matches: &Path) {
    if redirected(matches) {
        window::warn(format!("bare: {} is a link to another folder, so nothing in it was cleared, and matches cannot start until it is gone.", matches.display()));
        return;
    }
    for folder in std::fs::read_dir(matches).into_iter().flatten().flatten().map(|f| f.path()).filter(|f| is_match_folder(f)) {
        if let Some(pid) = std::fs::read_to_string(folder.join(PID_FILE)).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
            if pid != std::process::id() && command_line(pid).is_some_and(|c| is_child_of(&c, &folder)) {
                window::warn(format!("bare: ending {pid}, a match server left over from the last run"));
                kill(pid);
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        let _ = std::fs::remove_dir_all(&folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_map_grows_with_the_players() {
        assert_eq!([2, 6, 7, 8, 24, 25].map(sectors_for), [1, 1, 2, 2, 2, 3]);
    }

    #[test]
    fn objects_come_from_the_world_export() {
        let db = Json::parse(r#"{"collections":[{"name":"rooms.objects","data":[
            {"type":"controller","room":"W1N1","x":10,"y":11},
            {"type":"source","room":"W1N1","x":3,"y":4},
            {"type":"mineral","mineralType":"H","room":"W2N1","x":5,"y":6},
            {"type":"road","room":"W1N1","x":1,"y":1}]}]}"#).unwrap();
        let objects = read_objects(&db);
        assert_eq!(objects["W1N1"], [("controller".to_string(), 10, 11, None), ("source".to_string(), 3, 4, None)]);
        assert_eq!(objects["W2N1"], [("mineral".to_string(), 5, 6, Some("H".to_string()))]);
    }

    #[test]
    fn a_match_turns_on_what_only_a_match_may() {
        let config = child_config();
        let runner = config.get("runner").unwrap();
        assert_eq!(runner.get("setupList").and_then(Json::as_bool), Some(true));
        assert_eq!(runner.get("semiSpaceMb").and_then(Json::as_f64), Some(SEMI_SPACE_MB));
    }

    #[test]
    fn a_matchs_settings_hold_no_secret_and_it_has_no_console_or_fixed_port() {
        let config = child_config();
        assert!(config.get("http").is_none(), "a port or a password here would be for anyone who can change this file to set");
        assert_eq!(config.get("cli").unwrap().get("off").and_then(Json::as_bool), Some(true));
        assert!(CHILD_FLAGS.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]) && CHILD_FLAGS.windows(2).any(|pair| pair == ["--port", "0"]));
        assert!(CHILD_FLAGS.windows(2).any(|pair| pair == ["--cli-port", "0"]) && CHILD_FLAGS.contains(&"--password-stdin"));
        assert_ne!(random_hex(SECRET_BYTES), random_hex(SECRET_BYTES));
        assert_eq!(random_hex(SECRET_BYTES).len(), SECRET_BYTES * 2);
    }

    #[test]
    fn only_the_line_for_it_gives_a_port() {
        assert_eq!(announced(b"krebs-port 21555\n"), Some(21555));
        assert_eq!(announced(b"krebs-port 21555\r\n"), Some(21555));
        assert_eq!(announced(b"krebs 0.2.1 serving 100 rooms on http://127.0.0.1:21555 (tick rate 50 ms)\n"), None);
        for line in ["krebs-port \n", "krebs-port 70000\n", "krebs-port x\n", " krebs-port 1\n", ""] {
            assert_eq!(announced(line.as_bytes()), None, "{line:?}");
        }
    }

    /// One answer, and what was asked to get it.
    fn answer_once(reply: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            let n = s.read(&mut buffer).unwrap();
            s.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&buffer[..n]).to_string()
        });
        (port, asked)
    }

    #[test]
    fn every_call_to_a_match_carries_its_password() {
        let (port, asked) = answer_once("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}");
        Link { port, secret: "s3cret".into() }.text("GET", "/api/version", None, None).unwrap();
        assert!(asked.join().unwrap().contains("\r\nX-Server-Password: s3cret\r\n"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("krebs-sweep-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_sweep_clears_match_folders_and_nothing_else() {
        let dir = scratch("names");
        let matches = dir.join("bare").join("matches");
        for name in ["7", "12", "notes", "7a"] {
            std::fs::create_dir_all(matches.join(name)).unwrap();
        }
        std::fs::write(matches.join("3"), "a file, not a folder").unwrap();
        sweep(&matches);
        let mut left: Vec<String> = std::fs::read_dir(&matches).unwrap().map(|f| f.unwrap().file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left, ["3", "7a", "notes"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_folders_are_not_links() {
        let dir = scratch("plain");
        let matches = dir.join("bare").join("matches");
        assert!(!redirected(&matches), "not made yet is fine");
        std::fs::create_dir_all(&matches).unwrap();
        assert!(!redirected(&matches));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let made = Command::new(backend::steam_web::system_program("cmd")).arg("/c").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
    }

    #[cfg(windows)]
    #[test]
    fn the_sweep_stays_out_of_a_junction_at_either_step() {
        for step in ["matches", "bare"] {
            let dir = scratch(step);
            let elsewhere = dir.join("elsewhere");
            std::fs::create_dir_all(elsewhere.join("matches").join("1")).unwrap();
            std::fs::create_dir_all(elsewhere.join("1")).unwrap();
            let bare = dir.join("bare");
            if step == "bare" {
                junction(&bare, &elsewhere);
            } else {
                std::fs::create_dir_all(&bare).unwrap();
                junction(&bare.join("matches"), &elsewhere);
            }
            let matches = bare.join("matches");
            assert!(redirected(&matches), "{step}");
            sweep(&matches);
            assert!(elsewhere.join("1").is_dir() && elsewhere.join("matches").join("1").is_dir(), "{step}: nothing behind it went");
            let _ = std::fs::remove_dir(if step == "bare" { &bare } else { &matches });
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_named_like_a_match_is_not_cleared_through() {
        let dir = scratch("entry");
        let matches = dir.join("matches");
        std::fs::create_dir_all(&matches).unwrap();
        std::fs::create_dir_all(dir.join("elsewhere").join("keep")).unwrap();
        junction(&matches.join("5"), &dir.join("elsewhere"));
        assert!(!redirected(&matches));
        sweep(&matches);
        assert!(dir.join("elsewhere").join("keep").is_dir());
        let _ = std::fs::remove_dir(matches.join("5"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_match_of_ours_is_ended() {
        let folder = Path::new("data").join("bare").join("matches").join("3");
        let world = std::path::absolute(&folder).unwrap().join("world");
        let line = |data: &Path| format!(r#""C:\k\krebs.exe" serve --config x --data {} --tick-rate 50"#, data.display());
        assert!(is_child_of(&line(&world), &folder));
        assert!(is_child_of(&format!("{}\r\n", line(&world)), &folder), "as PowerShell gives it");
        assert!(is_child_of(&format!(r#"krebs.exe serve --data "{}" --tick-rate 50"#, world.display()), &folder), "a space in a folder gets it quoted");
        assert!(!is_child_of("notepad.exe", &folder));
        assert!(!is_child_of(&line(&Path::new("data").join("bare").join("matches").join("3").join("world")), &folder), "a child is told the whole path");
        assert!(!is_child_of(&line(&world).replace(" serve ", " export "), &folder));
    }

    #[test]
    fn a_copy_of_a_folder_leaves_the_first_ones_match_alone() {
        // the match in the first server's folder, and what the sweep of a copy of that folder looks at
        let copied = std::path::absolute(Path::new("copy")).unwrap().join("data").join("bare").join("matches").join("1");
        let first = std::path::absolute(Path::new("first")).unwrap().join("data").join("bare").join("matches").join("1").join("world");
        let line = format!("krebs.exe serve --config x --data {} --tick-rate 50 --mods devtools,matchrun", first.display());
        assert!(!is_child_of(&line, &copied));
        assert!(!is_child_of(&line, Path::new("data").join("bare").join("matches").join("1").as_path()), "nor a relative data folder");
        let inside = std::path::absolute(Path::new("first")).unwrap().join("old").join("first");
        let deeper = format!("krebs.exe serve --data {}{}world --tick-rate 50", inside.display(), std::path::MAIN_SEPARATOR);
        assert!(!is_child_of(&deeper, Path::new("first")), "part of a path is not the path");
    }

    #[cfg(windows)]
    #[test]
    fn the_case_of_a_folder_does_not_hide_a_leftover() {
        let folder = std::path::absolute(Path::new("Data")).unwrap().join("Matches").join("3");
        let line = format!("krebs.exe serve --data {} --tick-rate 50", folder.join("world").display().to_string().to_uppercase());
        assert!(is_child_of(&line, &folder));
    }

    #[cfg(windows)]
    #[test]
    fn what_a_child_prints_goes_to_its_log_but_for_the_port() {
        let dir = scratch("follow");
        let log = dir.join("server.log");
        let print = |text: &str| format!("echo {text}");
        let script = [print("loaded a world"), print("krebs-port 21555"), print("krebs-port 1"), print("serving")].join("& ");
        let mut child = Command::new(backend::steam_web::system_program("cmd")).args(["/c", &script]).stdout(Stdio::piped()).spawn().unwrap();
        let (told, port) = channel();
        follow(child.stdout.take().unwrap(), File::create(&log).unwrap(), told);
        let _ = child.wait();
        assert_eq!(port.iter().collect::<Vec<_>>(), [21555], "once");
        let said = std::fs::read_to_string(&log).unwrap();
        assert!(said.contains("loaded a world") && said.contains("krebs-port 1") && said.contains("serving") && !said.contains("21555"), "{said}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
