//! One match's own server: a `krebs serve` child process with a world made for that match, driven over its HTTP API.
//! `child.pid` in a match's folder names the running child: a child outlives a server that is killed, so the next start
//! ends whatever those files still name.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use util::json::Json;

const PID_FILE: &str = "child.pid";
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
}

pub(crate) struct World {
    process: Child,
    dir: PathBuf,
    pub link: Link,
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

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn run(exe: &Path, what: &str, dir: &Path, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let out = Command::new(exe).args(args).current_dir(dir).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr)))
}

/// A match's own `krebs.json`.
fn child_config() -> Json {
    backend::http::obj(vec![
        ("persist", backend::http::obj(vec![("intervalS", Json::Num(NO_CHECKPOINTS_S))])),
        ("engine", backend::http::obj(vec![("cpuMaxPerTick", Json::Num(CPU_MAX_PER_TICK))])),
        ("runner", backend::http::obj(vec![("semiSpaceMb", Json::Num(SEMI_SPACE_MB)), ("setupList", Json::Bool(true))])),
    ])
}

impl World {
    /// Generates a world in `dir` and serves it at 50 ms a tick: a paused world would apply commands but never publish
    /// them, so accounts made while it was paused could not sign in, and ticks cost nothing before anyone has a bot.
    pub fn start(dir: &Path, sectors: u32, seed: u64) -> Result<(World, Map), String> {
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

        let (port, cli_port) = (free_port()?, free_port()?);
        let config = dir.join("krebs.json");
        std::fs::write(&config, child_config().stringify()).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(dir.join("server.log")).map_err(|e| e.to_string())?;
        let process = Command::new(&exe)
            .arg("serve")
            .arg("--config")
            .arg(&config)
            .arg("--data")
            .arg(&data)
            .args(["--port", &port.to_string(), "--cli-port", &cli_port.to_string(), "--tick-rate", "50", "--mods", "devtools,matchrun"])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut world = World { process, dir, link: Link { port } };
        std::fs::write(world.dir.join(PID_FILE), world.process.id().to_string()).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(120);
        while world.link.http("GET", "/api/version", None, None).is_err() {
            if Instant::now() > deadline || world.exited() {
                return Err("the match server did not start".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let terrain = world.link.terrain(&rooms)?;
        Ok((world, Map { rooms, claimable, terrain, objects }))
    }

    /// Whether the child has gone, which no retry can change.
    pub fn exited(&mut self) -> bool {
        matches!(self.process.try_wait(), Ok(Some(_)))
    }

    fn stop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
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
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
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

/// A pid file can outlive its process, and after a reboot the number can belong to anything, so nothing is killed on the
/// number alone.
fn is_child_of(command_line: &str, folder: &Path) -> bool {
    command_line.contains("serve") && command_line.contains(folder.join("world").to_string_lossy().as_ref())
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let out = Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string()).filter(|s| !s.trim().is_empty())
}

#[cfg(not(windows))]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string()).filter(|s| !s.trim().is_empty())
}

#[cfg(windows)]
fn kill(pid: u32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
}

#[cfg(not(windows))]
fn kill(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}

/// Ends the worlds a previous server left running and clears their folders: lobbies live in memory, so those are lost.
pub(crate) fn sweep(matches: &Path) {
    for folder in std::fs::read_dir(matches).into_iter().flatten().flatten().map(|f| f.path()) {
        if let Some(pid) = std::fs::read_to_string(folder.join(PID_FILE)).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
            if pid != std::process::id() && command_line(pid).is_some_and(|c| is_child_of(&c, &folder)) {
                eprintln!("bare: ending {pid}, a match server left over from the last run");
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
    fn only_a_match_of_ours_is_ended() {
        let folder = Path::new("data").join("bare").join("matches").join("3");
        let line = format!("krebs.exe serve --data {}", folder.join("world").display());
        assert!(is_child_of(&line, &folder));
        assert!(!is_child_of("notepad.exe", &folder));
    }
}
