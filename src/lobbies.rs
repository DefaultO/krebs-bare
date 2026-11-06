//! Lobbies and Battle Royale matches. Everything lives in memory, so a server restart ends them, and a player's code is
//! only ever held here and in that match's world: no route gives it back.
//!
//! A lobby goes Open, Countdown, Preparing, Picking, Spawning, Running, Finished. Players are seated while their landing
//! page keeps asking; everything in `refresh` happens on those polls. `run` owns the match's world on a thread of its own.

use crate::steam;
use crate::world::{sectors_for, Link, Map, World};
use backend::http::{obj, Request, Response};
use backend::{field, str_field, ApiCtx};
use engine::doc::Val;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use util::json::Json;

const MAX_SEATS: usize = 8;
const COUNTDOWN_MS: u64 = 15_000;
/// The page asks every second, so this is several missed polls.
const SEAT_GONE_MS: u64 = 15_000;
/// How long a finished match stays listed.
const FINISHED_MS: u64 = 600_000;
/// Matches at once, finished ones aside. Each is a server process of its own with its bots running flat out.
const MAX_LIVE_MATCHES: usize = 4;
const TOO_MANY_MATCHES: &str = "Too many matches are running on this server. Press Ready again when one has ended.";
const TICKS: u64 = 1_000_000;
/// What fits in the body a world's `/api/user/code` is sent: `{"branch":"default","modules":...}`.
const MAX_CODE: usize = backend::http::MAX_BODY - 31;
/// Of `?rooms=`: more than a whole map's worth of names.
const MAX_ROOMS_ASKED: usize = 8192;
/// Each clears 4.3:1 on plain terrain, and none is the page's green, which only ever means something good.
const COLORS: [&str; MAX_SEATS] = ["#5fa8e6", "#e0a83e", "#e06a5a", "#a98be8", "#4fc3d9", "#e58fc0", "#d8d4c8", "#b9966f"];

static LOBBIES: Mutex<Lobbies> = Mutex::new(Lobbies::new());
static MATCHES: OnceLock<PathBuf> = OnceLock::new();

/// Where match worlds go; ends whatever a previous server left there.
pub(crate) fn init(data_dir: PathBuf) {
    let matches = data_dir.join("bare").join("matches");
    crate::world::sweep(&matches);
    let _ = MATCHES.set(matches);
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Open,
    Countdown,
    Preparing,
    Picking,
    Spawning,
    Running,
    Finished,
}

impl Phase {
    fn word(self) -> &'static str {
        match self {
            Phase::Open => "open",
            Phase::Countdown => "countdown",
            Phase::Preparing => "preparing",
            Phase::Picking => "picking",
            Phase::Spawning => "spawning",
            Phase::Running => "running",
            Phase::Finished => "finished",
        }
    }

    /// Once the bots run, a seat no longer depends on anyone being there.
    fn played_out(self) -> bool {
        matches!(self, Phase::Running | Phase::Finished)
    }

    /// A match's server is up, or on its way.
    fn has_server(self) -> bool {
        matches!(self, Phase::Preparing | Phase::Picking | Phase::Spawning | Phase::Running)
    }
}

struct Seat {
    user: String,
    name: String,
    /// Their SteamID64, which their picture is looked up by.
    steam: String,
    color: &'static str,
    /// Their account in the match's world, once there is one.
    account: String,
    code: Option<Arc<Json>>,
    ready: bool,
    room: Option<String>,
    locked: bool,
    spawned: bool,
    /// The tile their spawn went on, which only their own page is told.
    tile: Option<(i32, i32)>,
    seen_ms: u64,
    /// Went back to the list from a match that plays on, and can come back to it.
    away: bool,
}

struct Lobby {
    id: u64,
    name: String,
    /// The first seat is the host.
    seats: Vec<Seat>,
    /// Anyone else looking at a match under way: (user, last seen).
    watchers: Vec<(String, u64)>,
    phase: Phase,
    /// When the countdown ends, or when a finished lobby goes.
    ends_ms: u64,
    note: Option<String>,
    map: Option<Arc<Map>>,
    link: Option<Link>,
    password: String,
    tick: u64,
    stop: bool,
}

struct Lobbies {
    list: Vec<Lobby>,
    next_id: u64,
    /// Everyone whose page has asked, in a lobby or not: user and last seen. Never more than there are accounts.
    online: BTreeMap<String, u64>,
}

/// What the client's server card says.
#[derive(Debug, PartialEq)]
pub(crate) struct Card {
    pub(crate) people: usize,
    pub(crate) open: usize,
    pub(crate) live: usize,
}

fn random_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    util::sys::os_random(&mut raw);
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

impl Seat {
    fn new(me: &Player, color: &'static str, now: u64) -> Seat {
        Seat { user: me.id.clone(), name: me.name.clone(), steam: me.steam.clone(), color, account: String::new(), code: None, ready: false, room: None, locked: false, spawned: false, tile: None, seen_ms: now, away: false }
    }

    /// The name on Steam, which can arrive after the seat was taken and follows a change there.
    fn shown_name(&self) -> String {
        steam::picture(&self.steam).name.unwrap_or_else(|| self.name.clone())
    }
}

/// Each seat's name for an account in a world, which takes `^[a-zA-Z0-9_-]{3,}$` and no two alike: (user, account).
fn account_names(seats: &[Seat]) -> Vec<(String, String)> {
    let mut names: Vec<(String, String)> = Vec::new();
    for (i, seat) in seats.iter().enumerate() {
        let clean: String = seat.shown_name().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).collect();
        let taken = names.iter().any(|(_, name)| name.eq_ignore_ascii_case(&clean));
        names.push((seat.user.clone(), if clean.len() < 3 || taken { format!("Player{}", i + 1) } else { clean }));
    }
    names
}

impl Lobby {
    /// Called after the host, whose name on Steam can arrive after the lobby was made.
    fn title(&self) -> String {
        self.seats.first().map_or_else(|| self.name.clone(), |host| format!("{}'s lobby", host.shown_name()))
    }

    fn seat(&mut self, user: &str) -> Option<&mut Seat> {
        self.seats.iter_mut().find(|s| s.user == user)
    }

    fn all_ready(&self) -> bool {
        !self.seats.is_empty() && self.seats.iter().all(|s| s.ready)
    }

    fn free_color(&self) -> &'static str {
        COLORS.iter().find(|c| !self.seats.iter().any(|s| s.color == **c)).copied().unwrap_or(COLORS[0])
    }

    /// Back to an open lobby, with everyone's code still there. `note` is why.
    fn reopen(&mut self, note: String) {
        self.phase = Phase::Open;
        self.note = Some(note);
        self.map = None;
        self.link = None;
        for s in &mut self.seats {
            (s.ready, s.room, s.locked, s.spawned, s.tile) = (false, None, false, false, None);
        }
    }

    /// What follows from who is still here and what they have done. Returns true when the countdown just ran out.
    fn advance(&mut self, now: u64) -> bool {
        match self.phase {
            Phase::Open if self.all_ready() => {
                self.phase = Phase::Countdown;
                self.ends_ms = now + COUNTDOWN_MS;
            }
            Phase::Countdown if !self.all_ready() => self.phase = Phase::Open,
            Phase::Countdown if now >= self.ends_ms => {
                self.phase = Phase::Preparing;
                self.note = None;
                return true;
            }
            Phase::Picking if !self.seats.is_empty() && self.seats.iter().all(|s| s.locked) => self.phase = Phase::Spawning,
            Phase::Spawning if !self.seats.is_empty() && self.seats.iter().all(|s| s.spawned) => self.phase = Phase::Running,
            _ => {}
        }
        false
    }

    fn row(&self, me: Option<&str>, now: u64) -> Json {
        let seat = me.and_then(|m| self.seats.iter().find(|s| s.user == m));
        let mine = seat.is_some();
        let open = self.phase == Phase::Open || self.phase == Phase::Countdown;
        obj(vec![
            ("id", Json::Num(self.id as f64)),
            ("name", Json::Str(self.title())),
            ("players", Json::Num(self.seats.len() as f64)),
            ("max", Json::Num(MAX_SEATS as f64)),
            ("phase", Json::Str(self.phase.word().into())),
            ("joinable", Json::Bool(mine || self.phase == Phase::Running || (open && self.seats.len() < MAX_SEATS))),
            // `joinable` is true for anyone who could watch too, so these say it is your own seat to go back to
            ("mine", Json::Bool(mine)),
            ("away", Json::Bool(seat.is_some_and(|s| s.away))),
            ("leftMs", Json::Num(if self.phase == Phase::Countdown { self.ends_ms.saturating_sub(now) as f64 } else { 0.0 })),
            ("tick", Json::Num(self.tick as f64)),
            ("ticks", Json::Num(TICKS as f64)),
            ("seats", Json::Arr(self.seats.iter().map(|s| steam::seat_json(&s.shown_name(), s.color, s.ready, &steam::picture(&s.steam))).collect())),
        ])
    }

    fn detail(&self, me: &str, now: u64) -> Json {
        let seats = self.seats.iter().enumerate().map(|(i, s)| {
            let picture = steam::picture(&s.steam);
            let name = picture.name.unwrap_or_else(|| s.name.clone());
            let [avatar, frame] = [picture.avatar, picture.frame].map(|v| v.map_or(Json::Null, Json::Str));
            obj(vec![
                ("name", Json::Str(name)),
                ("avatar", avatar),
                ("frame", frame),
                ("account", Json::Str(s.account.clone())),
                ("color", Json::Str(s.color.into())),
                ("you", Json::Bool(s.user == me)),
                ("host", Json::Bool(i == 0)),
                ("hasCode", Json::Bool(s.code.is_some())),
                ("ready", Json::Bool(s.ready)),
                ("room", s.room.clone().map_or(Json::Null, Json::Str)),
                ("locked", Json::Bool(s.locked)),
                ("spawned", Json::Bool(s.spawned)),
                ("tile", s.tile.filter(|_| s.user == me).map_or(Json::Null, |(x, y)| Json::Arr(vec![Json::Num(x.into()), Json::Num(y.into())]))),
            ])
        });
        obj(vec![
            ("id", Json::Num(self.id as f64)),
            ("name", Json::Str(self.title())),
            ("phase", Json::Str(self.phase.word().into())),
            ("leftMs", Json::Num(self.ends_ms.saturating_sub(now) as f64)),
            ("tick", Json::Num(self.tick as f64)),
            ("ticks", Json::Num(TICKS as f64)),
            ("note", self.note.clone().map_or(Json::Null, Json::Str)),
            ("seats", Json::Arr(seats.collect())),
        ])
    }
}

impl Lobbies {
    const fn new() -> Lobbies {
        Lobbies { list: Vec::new(), next_id: 1, online: BTreeMap::new() }
    }

    fn get(&mut self, id: u64) -> Option<&mut Lobby> {
        self.list.iter_mut().find(|l| l.id == id)
    }

    /// The world of the match someone is in, once it runs. Before that, a spawn in it is known only to who placed it.
    fn running_link(&mut self, user: &str) -> Option<Link> {
        self.of(user).filter(|l| l.phase == Phase::Running).and_then(|l| l.link.clone())
    }

    fn of(&mut self, user: &str) -> Option<&mut Lobby> {
        self.list.iter_mut().find(|l| l.seats.iter().any(|s| s.user == user && !s.away) || l.watchers.iter().any(|(w, _)| w == user))
    }

    /// A poll: `me` is here, anyone who stopped asking is not, and the lobbies move on. Returns those whose match starts.
    fn refresh(&mut self, me: Option<&str>, now: u64) -> Vec<u64> {
        let mut started = Vec::new();
        let mut live = self.list.iter().filter(|l| l.phase.has_server()).count();
        if let Some(me) = me {
            self.online.insert(me.to_string(), now);
        }
        for l in &mut self.list {
            if let Some(seat) = me.and_then(|me| l.seats.iter_mut().find(|s| s.user == me)) {
                seat.seen_ms = now;
            }
            if let Some(watcher) = me.and_then(|me| l.watchers.iter_mut().find(|(w, _)| w == me)) {
                watcher.1 = now;
            }
            l.watchers.retain(|(_, seen)| now.saturating_sub(*seen) < SEAT_GONE_MS);
            if !l.phase.played_out() {
                l.seats.retain(|s| now.saturating_sub(s.seen_ms) < SEAT_GONE_MS);
            }
            if l.advance(now) {
                if live < MAX_LIVE_MATCHES {
                    live += 1;
                    started.push(l.id);
                } else {
                    l.reopen(TOO_MANY_MATCHES.into());
                }
            }
        }
        self.list.retain(|l| !l.seats.is_empty() && !(l.phase == Phase::Finished && (now >= l.ends_ms || l.seats.iter().all(|s| s.away))));
        started
    }

    /// Open counts as the page's own big number does. Only a page asking counts as a person, so the card's own checks do not.
    fn card(&self, now: u64) -> Card {
        Card {
            people: self.online.values().filter(|seen| now.saturating_sub(**seen) < SEAT_GONE_MS).count(),
            open: self.list.iter().filter(|l| matches!(l.phase, Phase::Open | Phase::Countdown)).count(),
            live: self.list.iter().filter(|l| l.phase == Phase::Running).count(),
        }
    }

    /// Out of a lobby. A match that plays on keeps the seat for when they come back; anything else gives it up.
    fn leave(&mut self, user: &str) {
        for l in &mut self.list {
            l.watchers.retain(|(w, _)| w != user);
            if l.phase.played_out() {
                if let Some(seat) = l.seat(user) {
                    seat.away = true;
                }
            } else {
                l.seats.retain(|s| s.user != user);
            }
        }
        self.list.retain(|l| !l.seats.is_empty());
    }

    fn create(&mut self, me: &Player, now: u64) -> u64 {
        self.leave(&me.id);
        let id = self.next_id;
        self.next_id += 1;
        let seat = Seat::new(me, COLORS[0], now);
        self.list.push(Lobby { id, name: format!("{}'s lobby", me.name), seats: vec![seat], watchers: Vec::new(), phase: Phase::Open, ends_ms: 0, note: None, map: None, link: None, password: String::new(), tick: 0, stop: false });
        id
    }

    fn join(&mut self, me: &Player, id: u64, now: u64) -> Result<(), &'static str> {
        let back = self.get(id).is_some_and(|l| l.seats.iter().any(|s| s.user == me.id));
        if !back {
            self.leave(&me.id);
        }
        let lobby = self.get(id).ok_or("That lobby is gone.")?;
        if let Some(seat) = lobby.seat(&me.id) {
            seat.away = false;
            return Ok(());
        }
        if lobby.phase == Phase::Running {
            lobby.watchers.push((me.id.clone(), now));
            return Ok(());
        }
        if !matches!(lobby.phase, Phase::Open | Phase::Countdown) {
            return Err("That match has already started.");
        }
        if lobby.seats.len() >= MAX_SEATS {
            return Err("That lobby is full.");
        }
        let color = lobby.free_color();
        lobby.seats.push(Seat::new(me, color, now));
        Ok(())
    }

    fn set_ready(&mut self, user: &str, ready: bool) -> Result<(), &'static str> {
        let lobby = self.of(user).ok_or("You are not in a lobby.")?;
        if !matches!(lobby.phase, Phase::Open | Phase::Countdown) {
            return Err("The match has started.");
        }
        let seat = lobby.seat(user).ok_or("You are not in a lobby.")?;
        if ready && seat.code.is_none() {
            return Err("Upload your code first.");
        }
        seat.ready = ready;
        Ok(())
    }

    fn pick(&mut self, user: &str, room: &str) -> Result<(), &'static str> {
        let lobby = self.of(user).ok_or("You are not in a lobby.")?;
        if lobby.phase != Phase::Picking {
            return Err("It is not time to pick a room.");
        }
        if !lobby.map.as_ref().is_some_and(|m| m.claimable.contains(room)) {
            return Err("That room has no controller.");
        }
        if lobby.seats.iter().any(|s| s.user != user && s.room.as_deref() == Some(room)) {
            return Err("Someone else picked that room.");
        }
        let seat = lobby.seat(user).ok_or("You are not in a lobby.")?;
        if seat.locked {
            return Err("You locked in your pick.");
        }
        seat.room = Some(room.to_string());
        Ok(())
    }

    /// Takes back a pick that is not locked in.
    fn unpick(&mut self, user: &str) -> Result<(), &'static str> {
        let lobby = self.of(user).ok_or("You are not in a lobby.")?;
        if lobby.phase != Phase::Picking {
            return Err("It is not time to pick a room.");
        }
        let seat = lobby.seat(user).ok_or("You are not in a lobby.")?;
        if seat.locked {
            return Err("You locked in your pick.");
        }
        seat.room = None;
        Ok(())
    }

    fn lock(&mut self, user: &str) -> Result<(), &'static str> {
        let lobby = self.of(user).ok_or("You are not in a lobby.")?;
        if lobby.phase != Phase::Picking {
            return Err("It is not time to pick a room.");
        }
        let seat = lobby.seat(user).ok_or("You are not in a lobby.")?;
        if seat.room.is_none() {
            return Err("Pick a room first.");
        }
        seat.locked = true;
        Ok(())
    }

    /// Stores a seat's code. Returns the lobby's name.
    fn upload(&mut self, user: &str, code: Arc<Json>) -> Result<String, (u16, &'static str)> {
        let by = |s: &Seat| s.user == user && !s.away;
        let lobby = self.list.iter_mut().find(|l| l.seats.iter().any(by)).ok_or((403, "You are not in a lobby."))?;
        if !matches!(lobby.phase, Phase::Open | Phase::Countdown) {
            return Err((409, "The match has started, so your code is locked."));
        }
        let seat = lobby.seats.iter_mut().find(|s| by(s)).ok_or((403, "You are not in a lobby."))?;
        seat.code = Some(code);
        Ok(lobby.title())
    }
}

struct Player {
    id: String,
    name: String,
    steam: String,
}

/// Who is asking. People go by their name on Steam. A new player has no username in this world, as the landing page covers
/// the client's name screen, so without a readable profile only the end of their SteamID is left.
fn player(ctx: &ApiCtx) -> Option<Player> {
    let view = ctx.published.get();
    let st = view.users.get(ctx.user? as usize)?;
    let steam = field(&st.doc, "steam").and_then(Val::as_obj).and_then(|o| str_field(o, "id")).unwrap_or("");
    let name = steam::picture(steam).name.or_else(|| str_field(&st.doc, "username").map(str::to_string)).unwrap_or_else(|| format!("Player {}", &steam[steam.len().saturating_sub(4)..]));
    Some(Player { id: st.id.as_str().to_string(), name, steam: steam.to_string() })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_millis() as u64)
}

/// `{"modules":{...}}`, as the page sends it.
fn read_code(body: &[u8]) -> Result<Json, &'static str> {
    let text = std::str::from_utf8(body).map_err(|_| "Your code is not UTF-8 text.")?;
    let parsed = Json::parse(text).map_err(|_| "There is no main module.")?;
    let Some(Json::Obj(modules)) = parsed.get("modules") else { return Err("There is no main module.") };
    if modules.iter().any(|(name, _)| name.starts_with(['$', '.', '/', '\\'])) {
        return Err("Module names cannot start with $, a dot or a slash.");
    }
    if modules.iter().any(|(_, m)| !matches!(m, Json::Str(_)) && m.get("binary").and_then(Json::as_str).is_none()) {
        return Err("Each module is text, or an object holding binary.");
    }
    match modules.iter().find(|(name, _)| name == "main").map(|(_, m)| m) {
        Some(Json::Str(main)) if !main.trim().is_empty() => {}
        _ => return Err("There is no main module."),
    }
    let code = Json::Obj(modules.clone());
    if code.stringify().len() > MAX_CODE {
        return Err("Your code is over 10 MB.");
    }
    Ok(code)
}

// ---- the match ----

fn edit(id: u64, f: impl FnOnce(&mut Lobby)) {
    if let Some(lobby) = LOBBIES.lock().unwrap().get(id) {
        f(lobby);
    }
}

/// `f` of the lobby, or `None` once it is gone.
fn read<T>(id: u64, f: impl FnOnce(&Lobby) -> T) -> Option<T> {
    LOBBIES.lock().unwrap().get(id).map(|l| f(l))
}

fn start_match(id: u64) {
    std::thread::spawn(move || {
        if let Err(why) = play(id) {
            eprintln!("bare: match {id}: {why}");
            edit(id, |l| l.reopen(format!("The match could not start: {why}")));
        }
    });
}

fn play(id: u64) -> Result<(), String> {
    let matches = MATCHES.get().ok_or("no data folder")?;
    let dir = matches.join(id.to_string());
    let _ = std::fs::remove_dir_all(&dir);
    let players = read(id, |l| l.seats.len() as u32).ok_or("the lobby is gone")?;
    let seed = u64::from((now_ms() as u32) | 1);
    let (mut world, map) = World::start(&dir, sectors_for(players), seed)?;
    let password = random_hex(16);
    let names = read(id, |l| account_names(&l.seats)).ok_or("the lobby is gone")?;
    for (_, name) in &names {
        world.link.create_account(name, &password)?;
    }
    let link = world.link.clone();
    edit(id, |l| {
        for (user, name) in &names {
            if let Some(seat) = l.seat(user) {
                seat.account = name.clone();
            }
        }
        l.map = Some(Arc::new(map));
        l.link = Some(link.clone());
        l.password = password.clone();
        l.phase = Phase::Picking;
    });

    // Picking and Spawning are the players': `pick`, `lock` and `spawn` move the lobby on
    loop {
        match read(id, |l| l.phase) {
            None => return Ok(()),
            Some(Phase::Running) => break,
            Some(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }

    // All the code at once, so every bot starts within a few ticks of the others
    let seats = read(id, |l| l.seats.iter().filter_map(|s| Some((s.account.clone(), s.code.clone()?))).collect::<Vec<_>>()).ok_or("the lobby is gone")?;
    for (name, code) in &seats {
        link.upload(name, &password, code)?;
    }
    drop(seats);
    edit(id, |l| l.seats.iter_mut().for_each(|s| s.code = None));
    let start = link.time()?;
    link.play_exactly(TICKS)?;
    loop {
        std::thread::sleep(Duration::from_millis(500));
        if world.exited() {
            return Err("the match server stopped".into());
        }
        let played = link.time().map_or(0, |now| now.saturating_sub(start)).min(TICKS);
        let stopped = read(id, |l| l.stop).unwrap_or(true);
        edit(id, |l| l.tick = l.tick.max(played));
        if stopped || played >= TICKS {
            break;
        }
    }
    edit(id, |l| {
        l.phase = Phase::Finished;
        l.ends_ms = now_ms() + FINISHED_MS;
        l.link = None;
    });
    Ok(())
}

// ---- routes ----

/// The card's numbers, taken fresh, as a server nobody has open gets no polls to move it on.
pub(crate) fn card() -> Card {
    let now = now_ms();
    let mut lobbies = LOBBIES.lock().unwrap();
    for started in lobbies.refresh(None, now) {
        start_match(started);
    }
    lobbies.card(now)
}

fn reply(me: Option<&Player>, lobbies: &mut Lobbies) -> Response {
    let now = now_ms();
    let id = me.map(|m| m.id.as_str());
    for started in lobbies.refresh(id, now) {
        start_match(started);
    }
    let rows = lobbies.list.iter().map(|l| l.row(id, now)).collect();
    let own = id.and_then(|m| lobbies.of(m).map(|l| l.detail(m, now)));
    let picture = me.map_or_else(steam::Picture::default, |m| steam::picture(&m.steam));
    Response::ok(obj(vec![
        ("me", me.map_or(Json::Null, |m| Json::Str(m.name.clone()))),
        ("avatar", picture.avatar.map_or(Json::Null, Json::Str)),
        ("frame", picture.frame.map_or(Json::Null, Json::Str)),
        ("lobbies", Json::Arr(rows)),
        ("lobby", own.unwrap_or(Json::Null)),
    ]))
}

/// A change by the player asking, and the same reply a poll gets, or the reason in `error`.
fn act(ctx: &ApiCtx, f: impl FnOnce(&Player, &mut Lobbies) -> Result<(), &'static str>) -> Response {
    let Some(me) = player(ctx) else { return Response::unauthorized() };
    let mut lobbies = LOBBIES.lock().unwrap();
    match f(&me, &mut lobbies) {
        Ok(()) => reply(Some(&me), &mut lobbies),
        Err(why) => Response::error(why),
    }
}

/// GET /api/lobbies
pub(crate) fn list(_req: &Request, ctx: &ApiCtx) -> Response {
    reply(player(ctx).as_ref(), &mut LOBBIES.lock().unwrap())
}

/// POST /api/lobbies/create
pub(crate) fn create(_req: &Request, ctx: &ApiCtx) -> Response {
    act(ctx, |me, l| {
        l.create(me, now_ms());
        Ok(())
    })
}

/// POST /api/lobbies/join {id}
pub(crate) fn join(req: &Request, ctx: &ApiCtx) -> Response {
    let id = req.body().get("id").and_then(Json::as_f64).unwrap_or(0.0) as u64;
    act(ctx, |me, l| l.join(me, id, now_ms()))
}

/// POST /api/lobbies/leave
pub(crate) fn leave(_req: &Request, ctx: &ApiCtx) -> Response {
    act(ctx, |me, l| {
        l.leave(&me.id);
        Ok(())
    })
}

/// POST /api/lobbies/ready {ready}
pub(crate) fn ready(req: &Request, ctx: &ApiCtx) -> Response {
    let on = req.body().get("ready").and_then(Json::as_bool).unwrap_or(false);
    act(ctx, |me, l| l.set_ready(&me.id, on))
}

/// POST /api/lobbies/pick {room}: no room takes back the one you had.
pub(crate) fn pick(req: &Request, ctx: &ApiCtx) -> Response {
    let body = req.body();
    let room = body.get("room").and_then(Json::as_str).unwrap_or("").to_string();
    act(ctx, |me, l| if room.is_empty() { l.unpick(&me.id) } else { l.pick(&me.id, &room) })
}

/// POST /api/lobbies/lock
pub(crate) fn lock(_req: &Request, ctx: &ApiCtx) -> Response {
    act(ctx, |me, l| l.lock(&me.id))
}

/// POST /api/lobbies/spawn {x, y}: the world decides, so it runs outside the lock every poll waits on.
pub(crate) fn spawn(req: &Request, ctx: &ApiCtx) -> Response {
    let Some(me) = player(ctx) else { return Response::unauthorized() };
    let body = req.body();
    let (x, y) = (body.get("x").and_then(Json::as_f64).unwrap_or(-1.0) as i32, body.get("y").and_then(Json::as_f64).unwrap_or(-1.0) as i32);
    let target = {
        let mut lobbies = LOBBIES.lock().unwrap();
        lobbies.of(&me.id).and_then(|l| {
            let seat = l.seats.iter().find(|s| s.user == me.id)?;
            (l.phase == Phase::Spawning && !seat.spawned).then(|| Some((l.id, l.link.clone()?, seat.account.clone(), l.password.clone(), seat.room.clone()?))).flatten()
        })
    };
    let Some((id, link, name, password, room)) = target else { return Response::error("It is not time to place a spawn.") };
    if let Err(why) = link.place_spawn(&name, &password, &room, x, y) {
        return Response::error(&format!("You can't place it there: {why}."));
    }
    edit(id, |l| {
        if let Some(seat) = l.seat(&me.id) {
            seat.spawned = true;
            seat.tile = Some((x, y));
        }
    });
    reply(Some(&me), &mut LOBBIES.lock().unwrap())
}

/// POST /api/lobbies/stop: the host ends a running match.
pub(crate) fn stop(_req: &Request, ctx: &ApiCtx) -> Response {
    act(ctx, |me, l| {
        let lobby = l.of(&me.id).ok_or("You are not in a lobby.")?;
        if lobby.seats[0].user != me.id || lobby.phase != Phase::Running {
            return Err("Only the host can stop a running match.");
        }
        lobby.stop = true;
        Ok(())
    })
}

/// GET /api/lobbies/live: the run you are in or watching, from its own server, so outside the lock every poll waits on.
pub(crate) fn live(_req: &Request, ctx: &ApiCtx) -> Response {
    let Some(me) = player(ctx) else { return Response::unauthorized() };
    let Some(link) = LOBBIES.lock().unwrap().running_link(&me.id) else { return Response::error("There is no match running.") };
    match link.view() {
        Ok(view) => Response::ok(view),
        Err(why) => Response::error(&why),
    }
}

/// GET /api/lobbies/rooms?rooms=W1N1,W2N1: what is in the rooms the page has on screen, as the match's world holds them.
pub(crate) fn rooms(req: &Request, ctx: &ApiCtx) -> Response {
    let Some(me) = player(ctx) else { return Response::unauthorized() };
    let wanted = req.param("rooms").unwrap_or("");
    // It goes into a request line by hand
    if wanted.len() > MAX_ROOMS_ASKED || !wanted.bytes().all(|b| b.is_ascii_alphanumeric() || b == b',') {
        return Response::error("Those are not room names.");
    }
    let Some(link) = LOBBIES.lock().unwrap().running_link(&me.id) else { return Response::error("There is no match running.") };
    match link.rooms(wanted) {
        Ok(json) => Response::text(200, "application/json; charset=utf-8", &json),
        Err(why) => Response::error(&why),
    }
}

/// GET /api/lobbies/map: the map of the match you are in. It never changes, so the page asks once.
pub(crate) fn map(_req: &Request, ctx: &ApiCtx) -> Response {
    let Some(me) = player(ctx) else { return Response::unauthorized() };
    let found = LOBBIES.lock().unwrap().of(&me.id).and_then(|l| l.map.clone());
    let Some(map) = found else { return Response::error("There is no map yet.") };
    let rooms = map.rooms.iter().map(|room| {
        let objects = map.objects.get(room).map_or(Vec::new(), |list| {
            list.iter()
                .map(|(kind, x, y, mineral)| {
                    let mut fields = vec![Json::Str(kind.clone()), Json::Num((*x).into()), Json::Num((*y).into())];
                    fields.extend(mineral.clone().map(Json::Str));
                    Json::Arr(fields)
                })
                .collect()
        });
        obj(vec![
            ("room", Json::Str(room.clone())),
            ("claimable", Json::Bool(map.claimable.contains(room))),
            ("terrain", Json::Str(map.terrain.get(room).cloned().unwrap_or_default())),
            ("objects", Json::Arr(objects)),
        ])
    });
    Response::ok(obj(vec![("rooms", Json::Arr(rooms.collect()))]))
}

/// POST /api/lobbies/upload: your code, from the page. One line of text back.
pub(crate) fn upload(req: &Request, ctx: &ApiCtx) -> Response {
    let line = |status, text: &str| Response::text(status, "text/plain; charset=utf-8", &format!("{text}\n"));
    let Some(me) = player(ctx) else { return line(401, "Reconnect, then upload again.") };
    let code = match read_code(&req.body) {
        Ok(code) => Arc::new(code),
        Err(why) => return line(400, why),
    };
    match LOBBIES.lock().unwrap().upload(&me.id, code) {
        Ok(lobby) => line(200, &format!("Code uploaded to {lobby}.")),
        Err((status, why)) => line(status, why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(id: &str) -> Player {
        Player { id: id.into(), name: format!("Name{id}"), steam: String::new() }
    }

    fn code() -> Arc<Json> {
        Arc::new(read_code(br#"{"modules":{"main":"module.exports.loop = function () {};"}}"#).unwrap())
    }

    /// A lobby of `ids` with code uploaded, hosted by the first.
    fn lobby(ids: &[&str]) -> (Lobbies, u64) {
        let mut l = Lobbies::new();
        let id = l.create(&player(ids[0]), 0);
        for other in &ids[1..] {
            l.join(&player(other), id, 0).unwrap();
        }
        for user in ids {
            l.upload(user, code()).unwrap();
        }
        (l, id)
    }

    fn phase(l: &mut Lobbies, id: u64) -> Phase {
        l.get(id).unwrap().phase
    }

    fn all_ready(l: &mut Lobbies, ids: &[&str]) {
        for user in ids {
            l.set_ready(user, true).unwrap();
        }
    }

    /// A lobby past its countdown, with the world up and a map of two rooms.
    fn picking(ids: &[&str]) -> (Lobbies, u64) {
        let (mut l, id) = lobby(ids);
        let lobby = l.get(id).unwrap();
        lobby.phase = Phase::Picking;
        let claimable = ["W1N1", "W2N1", "W3N1"].map(str::to_string).into_iter().collect();
        lobby.map = Some(Arc::new(Map { rooms: vec![], claimable, terrain: Default::default(), objects: Default::default() }));
        (l, id)
    }

    #[test]
    fn creating_seats_the_host_and_rows_say_who_can_join() {
        let (mut l, id) = lobby(&["a"]);
        assert_eq!(l.list[0].name, "Namea's lobby");
        assert_eq!(l.get(id).unwrap().row(Some("b"), 0).get("joinable").and_then(Json::as_bool), Some(true));
        l.get(id).unwrap().phase = Phase::Picking;
        assert_eq!(l.get(id).unwrap().row(Some("b"), 0).get("joinable").and_then(Json::as_bool), Some(false));
        assert_eq!(l.get(id).unwrap().row(Some("a"), 0).get("joinable").and_then(Json::as_bool), Some(true), "your own match, to come back to");
        l.get(id).unwrap().phase = Phase::Running;
        assert_eq!(l.get(id).unwrap().row(Some("b"), 0).get("joinable").and_then(Json::as_bool), Some(true), "to watch");
    }

    #[test]
    fn a_row_tells_your_own_seat_from_one_you_could_watch() {
        let (mut l, id) = lobby(&["a"]);
        l.get(id).unwrap().phase = Phase::Running;
        let says = |l: &mut Lobbies, who: &str, field: &str| l.get(id).unwrap().row(Some(who), 0).get(field).and_then(Json::as_bool);
        assert_eq!(says(&mut l, "a", "mine"), Some(true));
        assert_eq!(says(&mut l, "a", "away"), Some(false));
        assert_eq!(says(&mut l, "b", "mine"), Some(false));
        l.leave("a");
        assert_eq!(says(&mut l, "a", "mine"), Some(true), "going back to the list keeps the seat");
        assert_eq!(says(&mut l, "a", "away"), Some(true));
        assert_eq!(says(&mut l, "b", "away"), Some(false));
    }

    #[test]
    fn a_row_says_how_long_a_countdown_has_left() {
        let (mut l, id) = lobby(&["a"]);
        assert_eq!(l.get(id).unwrap().row(None, 0).get("leftMs").and_then(Json::as_f64), Some(0.0));
        all_ready(&mut l, &["a"]);
        l.refresh(Some("a"), 0);
        assert_eq!(l.get(id).unwrap().row(None, 1000).get("leftMs").and_then(Json::as_f64), Some((COUNTDOWN_MS - 1000) as f64));
    }

    #[test]
    fn the_match_world_stays_closed_until_the_match_runs() {
        let (mut l, id) = lobby(&["a", "b"]);
        l.get(id).unwrap().link = Some(Link::nowhere());
        for phase in [Phase::Picking, Phase::Spawning] {
            l.get(id).unwrap().phase = phase;
            assert!(l.running_link("b").is_none(), "a rival's spawn is already in that world");
        }
        l.get(id).unwrap().phase = Phase::Running;
        assert!(l.running_link("b").is_some());
        assert!(l.running_link("c").is_none(), "not your match");
    }

    #[test]
    fn only_your_own_page_is_told_where_your_spawn_went() {
        let (mut l, id) = lobby(&["a", "b"]);
        l.get(id).unwrap().seats[0].tile = Some((24, 31));
        let tile = |l: &mut Lobbies, who: &str| l.get(id).unwrap().detail(who, 0).get("seats").and_then(|seats| seats.at(0)).and_then(|seat| seat.get("tile")).and_then(Json::as_array).map(Vec::len);
        assert_eq!(tile(&mut l, "a"), Some(2));
        assert_eq!(tile(&mut l, "b"), None, "their tile is not yours to know");
    }

    #[test]
    fn players_get_their_own_colours_and_one_lobby_at_a_time() {
        let (mut l, first) = lobby(&["a", "b"]);
        let colors: Vec<&str> = l.get(first).unwrap().seats.iter().map(|s| s.color).collect();
        assert_eq!(colors, [COLORS[0], COLORS[1]]);
        let second = l.create(&player("c"), 0);
        l.join(&player("a"), second, 0).unwrap();
        assert_eq!(l.get(first).unwrap().seats.len(), 1, "a left the first one");
        assert_eq!(l.get(first).unwrap().seats[0].user, "b", "and b hosts it now");
    }

    #[test]
    fn a_full_or_started_lobby_refuses() {
        let (mut l, id) = lobby(&["a"]);
        for n in 0..7 {
            l.join(&player(&n.to_string()), id, 0).unwrap();
        }
        assert_eq!(l.join(&player("late"), id, 0), Err("That lobby is full."));
        assert_eq!(l.join(&player("late"), 99, 0), Err("That lobby is gone."));
        let (mut l, id) = picking(&["a"]);
        assert_eq!(l.join(&player("late"), id, 0), Err("That match has already started."));
    }

    #[test]
    fn ready_needs_code() {
        let mut l = Lobbies::new();
        let id = l.create(&player("a"), 0);
        assert_eq!(l.set_ready("a", true), Err("Upload your code first."));
        l.upload("a", code()).unwrap();
        l.set_ready("a", true).unwrap();
        assert!(l.get(id).unwrap().seats[0].ready);
        l.set_ready("a", false).unwrap();
        assert!(!l.get(id).unwrap().seats[0].ready);
    }

    #[test]
    fn code_goes_to_your_own_seat() {
        let (mut l, id) = lobby(&["a", "b"]);
        l.get(id).unwrap().seats[1].code = None;
        assert_eq!(l.upload("a", code()), Ok("Namea's lobby".to_string()));
        assert!(l.get(id).unwrap().seats[1].code.is_none());
        assert!(l.upload("stranger", code()).is_err());
    }

    #[test]
    fn the_countdown_starts_with_everyone_ready_and_stops_without() {
        let (mut l, id) = lobby(&["a", "b"]);
        l.set_ready("a", true).unwrap();
        l.refresh(Some("a"), 1);
        assert_eq!(phase(&mut l, id), Phase::Open);
        l.set_ready("b", true).unwrap();
        l.refresh(Some("b"), 1);
        assert_eq!(phase(&mut l, id), Phase::Countdown);
        assert_eq!(l.get(id).unwrap().ends_ms, 1 + COUNTDOWN_MS);
        l.set_ready("b", false).unwrap();
        l.refresh(Some("b"), 2);
        assert_eq!(phase(&mut l, id), Phase::Open, "unready stops it");
    }

    #[test]
    fn someone_joining_stops_the_countdown() {
        let (mut l, id) = lobby(&["a"]);
        all_ready(&mut l, &["a"]);
        l.refresh(Some("a"), 0);
        assert_eq!(phase(&mut l, id), Phase::Countdown);
        l.join(&player("b"), id, 1).unwrap();
        l.refresh(Some("a"), 1);
        assert_eq!(phase(&mut l, id), Phase::Open);
    }

    #[test]
    fn the_match_starts_when_the_countdown_ends() {
        let (mut l, id) = lobby(&["a"]);
        all_ready(&mut l, &["a"]);
        l.refresh(Some("a"), 0);
        assert!(l.refresh(Some("a"), COUNTDOWN_MS - 1).is_empty());
        assert_eq!(l.refresh(Some("a"), COUNTDOWN_MS), [id], "exactly once");
        assert_eq!(phase(&mut l, id), Phase::Preparing);
        assert!(l.refresh(Some("a"), COUNTDOWN_MS + 1).is_empty());
    }

    #[test]
    fn a_room_is_one_players() {
        let (mut l, _) = picking(&["a", "b"]);
        assert_eq!(l.pick("a", "W9N9"), Err("That room has no controller."));
        l.pick("a", "W1N1").unwrap();
        assert_eq!(l.pick("b", "W1N1"), Err("Someone else picked that room."));
        l.pick("a", "W2N1").unwrap();
        l.pick("b", "W1N1").unwrap();
        l.lock("a").unwrap();
        assert_eq!(l.pick("a", "W3N1"), Err("You locked in your pick."));
    }

    #[test]
    fn a_pick_can_be_taken_back_until_it_is_locked() {
        let (mut l, id) = picking(&["a", "b"]);
        l.pick("a", "W1N1").unwrap();
        l.unpick("a").unwrap();
        assert_eq!(l.get(id).unwrap().seats[0].room, None);
        l.pick("b", "W1N1").unwrap();
        l.lock("b").unwrap();
        assert_eq!(l.unpick("b"), Err("You locked in your pick."));
    }

    #[test]
    fn everyone_locked_moves_to_spawns_and_everyone_placed_moves_to_the_match() {
        let (mut l, id) = picking(&["a", "b"]);
        assert_eq!(l.lock("a"), Err("Pick a room first."));
        l.pick("a", "W1N1").unwrap();
        l.pick("b", "W2N1").unwrap();
        l.lock("a").unwrap();
        l.refresh(Some("a"), 1);
        assert_eq!(phase(&mut l, id), Phase::Picking);
        l.lock("b").unwrap();
        l.refresh(Some("b"), 1);
        assert_eq!(phase(&mut l, id), Phase::Spawning);
        l.get(id).unwrap().seats[0].spawned = true;
        l.refresh(Some("a"), 2);
        assert_eq!(phase(&mut l, id), Phase::Spawning);
        l.get(id).unwrap().seats[1].spawned = true;
        l.refresh(Some("b"), 2);
        assert_eq!(phase(&mut l, id), Phase::Running);
    }

    #[test]
    fn nobody_waits_for_a_player_who_left() {
        let (mut l, id) = picking(&["a", "b"]);
        l.pick("a", "W1N1").unwrap();
        l.lock("a").unwrap();
        l.leave("b");
        l.refresh(Some("a"), 1);
        assert_eq!(phase(&mut l, id), Phase::Spawning);
    }

    #[test]
    fn seats_go_when_their_page_goes_quiet_until_the_bots_run() {
        let (mut l, id) = lobby(&["a", "b"]);
        l.refresh(Some("a"), SEAT_GONE_MS - 1);
        l.refresh(Some("a"), SEAT_GONE_MS + 1);
        assert_eq!(l.get(id).unwrap().seats.len(), 1);
        l.refresh(None, 3 * SEAT_GONE_MS);
        assert!(l.list.is_empty(), "nobody left");
        let (mut l, id) = lobby(&["a"]);
        l.get(id).unwrap().phase = Phase::Running;
        l.refresh(None, 3 * SEAT_GONE_MS);
        assert_eq!(l.list.len(), 1, "a match plays on without anyone watching");
    }

    #[test]
    fn the_card_counts_who_is_here_and_what_is_going_on() {
        let (mut l, id) = lobby(&["a", "b"]);
        assert_eq!(l.card(0), Card { people: 0, open: 1, live: 0 }, "seated is not the same as a page asking");
        l.refresh(Some("a"), 0);
        l.refresh(Some("c"), 0);
        l.refresh(None, 1);
        assert_eq!(l.card(1), Card { people: 2, open: 1, live: 0 }, "on the list counts, and a check with no player does not");
        l.get(id).unwrap().phase = Phase::Countdown;
        assert_eq!(l.card(1).open, 1);
        l.get(id).unwrap().phase = Phase::Picking;
        assert_eq!(l.card(1), Card { people: 2, open: 0, live: 0 });
        l.get(id).unwrap().phase = Phase::Running;
        assert_eq!(l.card(1), Card { people: 2, open: 0, live: 1 });
        assert_eq!(l.card(SEAT_GONE_MS).people, 0, "gone once they stop asking");
        assert_eq!(l.card(SEAT_GONE_MS).live, 1, "the match plays on");
    }

    #[test]
    fn anyone_can_watch_a_running_match_and_leave_again() {
        let (mut l, id) = lobby(&["a"]);
        l.get(id).unwrap().phase = Phase::Running;
        l.join(&player("b"), id, 0).unwrap();
        assert!(l.of("b").is_some());
        assert_eq!(l.get(id).unwrap().seats.len(), 1, "watching takes no seat");
        l.leave("b");
        assert!(l.of("b").is_none());
        l.join(&player("c"), id, 0).unwrap();
        l.refresh(Some("a"), SEAT_GONE_MS + 1);
        assert!(l.of("c").is_none(), "a watcher who went quiet is gone");
        assert_eq!(l.list.len(), 1, "and the match plays on");
    }

    #[test]
    fn leaving_a_running_match_keeps_the_seat_to_come_back_to() {
        let (mut l, id) = lobby(&["a"]);
        l.get(id).unwrap().phase = Phase::Running;
        l.leave("a");
        assert!(l.of("a").is_none());
        assert_eq!(l.list.len(), 1);
        l.join(&player("a"), id, 1).unwrap();
        assert!(l.of("a").is_some());
    }

    #[test]
    fn matches_at_once_have_a_limit() {
        let mut l = Lobbies::new();
        let hosts: Vec<String> = (0..=MAX_LIVE_MATCHES).map(|n| format!("host{n}")).collect();
        for host in &hosts {
            l.create(&player(host), 0);
            l.upload(host, code()).unwrap();
            l.set_ready(host, true).unwrap();
        }
        // everyone's page keeps asking
        let seen_at = |l: &mut Lobbies, now: u64| l.list.iter_mut().flat_map(|lobby| &mut lobby.seats).for_each(|s| s.seen_ms = now);
        l.refresh(None, 0); // into the countdown
        seen_at(&mut l, COUNTDOWN_MS);
        assert_eq!(l.refresh(None, COUNTDOWN_MS).len(), MAX_LIVE_MATCHES);
        let refused = l.list.iter().find(|lobby| lobby.phase == Phase::Open).expect("the one over the limit is open again");
        assert_eq!(refused.note.as_deref(), Some(TOO_MANY_MATCHES));
        assert!(refused.seats.iter().all(|s| !s.ready && s.code.is_some()), "nobody loses their code, and they can press Ready again");

        // a finished match no longer counts
        l.list[0].phase = Phase::Finished;
        l.list[0].ends_ms = u64::MAX;
        let id = l.list.iter().find(|lobby| lobby.phase == Phase::Open).unwrap().id;
        let host = l.get(id).unwrap().seats[0].user.clone();
        l.set_ready(&host, true).unwrap();
        l.refresh(None, COUNTDOWN_MS);
        seen_at(&mut l, COUNTDOWN_MS * 2);
        assert_eq!(l.refresh(None, COUNTDOWN_MS * 2), vec![id]);
    }

    #[test]
    fn a_failed_start_keeps_everyones_code() {
        let (mut l, id) = lobby(&["a"]);
        all_ready(&mut l, &["a"]);
        l.get(id).unwrap().reopen("nope".into());
        let lobby = l.get(id).unwrap();
        assert_eq!(lobby.phase, Phase::Open);
        assert!(lobby.seats[0].code.is_some() && !lobby.seats[0].ready);
    }

    #[test]
    fn a_finished_match_goes_in_time() {
        let (mut l, id) = lobby(&["a"]);
        let lobby = l.get(id).unwrap();
        lobby.phase = Phase::Finished;
        lobby.ends_ms = 10;
        l.refresh(Some("a"), 9);
        assert_eq!(l.list.len(), 1);
        l.refresh(Some("a"), 10);
        assert!(l.list.is_empty());
    }

    #[test]
    fn code_comes_as_modules() {
        let main = |j: Json| j.get("main").and_then(Json::as_str).map(str::to_string);
        assert_eq!(read_code(b"console.log(1)").unwrap_err(), "There is no main module.");
        assert_eq!(main(read_code(br#"{"modules":{"main":"x()","lib":"y()"}}"#).unwrap()), Some("x()".to_string()));
        assert_eq!(read_code(br#"{"modules":{"lib":"y()"}}"#).unwrap_err(), "There is no main module.");
        assert_eq!(read_code(br#"{"modules":{"main":"x()","$a":"y()"}}"#).unwrap_err(), "Module names cannot start with $, a dot or a slash.");
        assert_eq!(read_code(br#"{"modules":{"main":"x()","a":5}}"#).unwrap_err(), "Each module is text, or an object holding binary.");
        assert!(read_code(br#"{"modules":{"main":"x()","a":{"binary":"AA=="}}}"#).is_ok());
    }

    #[test]
    fn code_can_pass_the_games_5_mb_up_to_what_a_world_can_be_sent() {
        let sized = |n: usize| format!(r#"{{"modules":{{"main":"{}"}}}}"#, "x".repeat(n));
        assert!(read_code(sized(8 << 20).as_bytes()).is_ok());
        assert_eq!(read_code(sized(MAX_CODE).as_bytes()).unwrap_err(), "Your code is over 10 MB.");
    }

    #[test]
    fn no_reply_holds_anyones_code() {
        let (mut l, id) = lobby(&["a"]);
        let lobby = l.get(id).unwrap();
        let text = format!("{}{}", lobby.detail("a", 0).stringify(), lobby.row(Some("a"), 0).stringify());
        assert!(!text.contains("module.exports"));
    }

    #[test]
    fn account_names_are_ones_a_world_accepts() {
        let names = |list: &[&str]| {
            let seats: Vec<Seat> = list.iter().map(|n| Seat::new(&Player { id: n.to_string(), name: n.to_string(), steam: String::new() }, COLORS[0], 0)).collect();
            account_names(&seats).into_iter().map(|(_, name)| name).collect::<Vec<_>>()
        };
        assert_eq!(names(&["Namea", "Player 1234", "Дима"]), ["Namea", "Player1234", "Player3"]);
        assert_eq!(names(&["a b", "ab"]), ["Player1", "Player2"], "too short once cleaned");
        assert_eq!(names(&["A-1", "a-1"]), ["A-1", "Player2"], "a world's names ignore case");
    }

    #[test]
    fn a_finished_lobby_goes_once_everyone_has_left_it() {
        let (mut l, id) = lobby(&["a"]);
        let lobby = l.get(id).unwrap();
        lobby.phase = Phase::Finished;
        lobby.ends_ms = 1_000_000;
        l.leave("a");
        l.refresh(None, 1);
        assert!(l.list.is_empty());
    }
}
