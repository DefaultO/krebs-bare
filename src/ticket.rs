//! Who a Steam ticket belongs to, proved. A ticket holds a part Steam signed: this SteamID, this game, until this date. The
//! signature is checked here against Steam's public key, so nobody can make up a ticket for someone else, and that costs no
//! setup, no internet and no call to Steam. That is all a server alone on its host's PC does.
//!
//! The signed part stays good for 21 days after Steam made it, though, and the client cancels the ticket around it as soon
//! as it has signed in. So a server others can reach has the host's Steam Web API key, and for a ticket that passes here it
//! also asks Steam whether that ticket is good right now (`backend::steam_web`). When Steam cannot say, the answer is no.
//!
//! Not covered: the host a player joined holds their ticket, and the client only cancels one after a sign-in that worked. So
//! a dishonest host can answer with an error, and pass the ticket on to another server while that client runs. A ticket is
//! no way into Steam itself.
//!
//! A ticket, all little-endian: at 0 the u32 20, at 12 the u64 SteamID, at 24 the u32 24, at 52 a u32 length of everything
//! after it, and at 56 the signed part, then Steam's 128-byte RSA signature of it (PKCS#1 v1.5, SHA-1). The signed part
//! starts with a u32 of its own length; see `VERSION` and below for the rest. Nothing outside it is worth anything alone.

use backend::steam_web::{self, Answer};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Screeps on Steam.
const SCREEPS: u32 = 464_350;
/// A key that replaces Steam's, as hex, for testing a server with made-up players: a test signs its own tickets, so they
/// go through everything real ones do. It takes setting this on the host, so it opens nothing to anyone else.
const TEST_KEY: &str = "KREBS_TEST_STEAM_KEY";
/// A little more than any ticket, which is a few hundred bytes.
const MOST_BYTES: usize = 8_192;
/// How wrong the host's clock can be.
const CLOCK_SLACK_S: u64 = 86_400;
/// Players Steam is being asked about at once. Each question is a process and a call on the host's daily allowance, and a
/// ticket with a good signature can be sent again and again, so the limit goes by the signed SteamID, which a sender cannot vary.
const MOST_ASKED: usize = 8;
/// How long a player stays taken: longer than curl may take, so a no holds that player for this long after it was asked.
const ASK_GAP: Duration = Duration::from_secs(5);
/// How long a sign-in waits for a turn. The client never tries twice, and a restart brings everyone back at once.
const TURN_WAIT: Duration = Duration::from_secs(6);
const TURN_POLL: Duration = Duration::from_millis(100);

/// Where the signed part starts, and what is in it.
const SIGNED_AT: usize = 56;
const VERSION_AT: usize = 4;
const STEAM_ID_AT: usize = 8;
const APP_AT: usize = 16;
const EXPIRES_AT: usize = 36;
/// The layout above. A signature proves who wrote a ticket, not that its fields are where this looks for them.
const VERSION: u32 = 4;

/// Steam's public key (the "system" key), as SteamKit and others publish it, with the exponent 17.
const STEAM_KEY: Key = [
    0xdf, 0xec, 0x1a, 0xd6, 0x2c, 0x10, 0x66, 0x2c, 0x17, 0x35, 0x3a, 0x14, 0xb0, 0x7c, 0x59, 0x11,
    0x7f, 0x9d, 0xd3, 0xd8, 0x2b, 0x7a, 0xe3, 0xe0, 0x15, 0xcd, 0x19, 0x1e, 0x46, 0xe8, 0x7b, 0x87,
    0x74, 0xa2, 0x18, 0x46, 0x31, 0xa9, 0x03, 0x14, 0x79, 0x82, 0x8e, 0xe9, 0x45, 0xa2, 0x49, 0x12,
    0xa9, 0x23, 0x68, 0x73, 0x89, 0xcf, 0x69, 0xa1, 0xb1, 0x61, 0x46, 0xbd, 0xc1, 0xbe, 0xbf, 0xd6,
    0x01, 0x1b, 0xd8, 0x81, 0xd4, 0xdc, 0x90, 0xfb, 0xfe, 0x4f, 0x52, 0x73, 0x66, 0xcb, 0x95, 0x70,
    0xd7, 0xc5, 0x8e, 0xba, 0x1c, 0x7a, 0x33, 0x75, 0xa1, 0x62, 0x34, 0x46, 0xbb, 0x60, 0xb7, 0x80,
    0x68, 0xfa, 0x13, 0xa7, 0x7a, 0x8a, 0x37, 0x4b, 0x9e, 0xc6, 0xf4, 0x5d, 0x5f, 0x3a, 0x99, 0xf9,
    0x9e, 0xc4, 0x3a, 0xe9, 0x63, 0xa2, 0xbb, 0x88, 0x19, 0x28, 0xe0, 0xe7, 0x14, 0xc0, 0x42, 0x89,
];
const EXPONENT: u32 = 17;

const SIZE: usize = 128;
type Key = [u8; SIZE];
/// A number below 2^1024, lowest word first.
type Number = [u32; SIZE / 4];

/// DER for "this is a SHA-1 hash", which goes in front of the hash in what gets signed.
const SHA1_PREFIX: [u8; 15] = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Refused {
    NotATicket,
    NotSigned,
    NewLayout,
    TwoPlayers,
    OtherGame,
    Expired,
    SteamSaidNo,
    KeyRefused,
    NoAnswer,
    TooMany,
}

impl Refused {
    fn words(self) -> &'static str {
        match self {
            Refused::NotATicket => "that was not a Steam ticket.",
            Refused::NotSigned => "Steam did not sign that ticket.",
            Refused::NewLayout => "Steam has changed its tickets, and nobody can sign in until this Krebs is updated.",
            Refused::TwoPlayers => "that ticket names two different players. If it was a real player, tell the makers of Krebs.",
            Refused::OtherGame => "that ticket is for another game.",
            Refused::Expired => "that ticket has run out. The player should restart Steam while online. Check the date and time on this PC too.",
            Refused::SteamSaidNo => "Steam says that ticket is not in use. If it was a real player, they should restart Steam.",
            Refused::KeyRefused => "Steam no longer takes the key in steam-api-key.txt in the data folder, so nobody can sign in. Close this and start Let friends join.bat again.",
            Refused::NoAnswer => "Steam did not answer, so nobody can sign in until it does. Check this PC's internet.",
            Refused::TooMany => "too many sign-ins at once. Trying again in a moment will work.",
        }
    }
}

/// The SteamID64 a ticket (hex) proves. Each refusal is said in the host's window, so a player who cannot get in can be helped.
pub(crate) fn steam_id(ticket: &str) -> Option<u64> {
    let now_s = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_secs());
    let id = check(ticket, key(), now_s).and_then(|id| asked(ticket, id).map(|()| id));
    id.inspect_err(|why| say_refused(*why, now_s)).ok()
}

/// From here on a ticket that passes `check` has to pass Steam too.
pub(crate) fn ask_steam(with_key: Option<String>) {
    if let Some(key) = with_key {
        let _ = WEB_KEY.set(key);
    }
}

static WEB_KEY: OnceLock<String> = OnceLock::new();
/// The players taken, and until when.
static TAKEN: Mutex<BTreeMap<u64, Instant>> = Mutex::new(BTreeMap::new());

/// Whether `id` gets a turn now, which then lasts `ASK_GAP` unless a yes gives it back early.
fn take_turn(taken: &mut BTreeMap<u64, Instant>, id: u64, now: Instant) -> bool {
    taken.retain(|_, until| *until > now);
    let free = taken.len() < MOST_ASKED && !taken.contains_key(&id);
    if free {
        taken.insert(id, now + ASK_GAP);
    }
    free
}

fn wait_for_turn(id: u64) -> bool {
    let end = Instant::now() + TURN_WAIT;
    loop {
        let now = Instant::now();
        if take_turn(&mut TAKEN.lock().unwrap(), id, now) {
            return true;
        }
        if now >= end {
            return false;
        }
        std::thread::sleep(TURN_POLL);
    }
}

/// Steam knows nothing of a ticket signed with the test key, so nothing is asked then.
fn asked(ticket: &str, id: u64) -> Result<(), Refused> {
    let Some(web_key) = WEB_KEY.get().filter(|_| *key() == STEAM_KEY) else { return Ok(()) };
    if !wait_for_turn(id) {
        return Err(Refused::TooMany);
    }
    let said = verdict(steam_web::ask(web_key, ticket), id);
    if said.is_ok() {
        TAKEN.lock().unwrap().remove(&id);
    }
    said
}

fn verdict(answer: Answer, id: u64) -> Result<(), Refused> {
    match answer {
        Answer::Good(said) if said == id => Ok(()),
        Answer::Good(_) | Answer::Bad => Err(Refused::SteamSaidNo),
        Answer::KeyRefused => Err(Refused::KeyRefused),
        Answer::NoAnswer => Err(Refused::NoAnswer),
    }
}

/// Steam's key, unless `TEST_KEY` holds a whole one. Said at the start, by calling this from `register`.
pub(crate) fn key() -> &'static Key {
    static KEY: OnceLock<Key> = OnceLock::new();
    KEY.get_or_init(|| {
        let test = std::env::var(TEST_KEY).ok().and_then(|hex| decode(&hex)).and_then(|bytes| Key::try_from(bytes).ok());
        if test.is_some() {
            println!("{TEST_KEY} is set, so this server takes tickets signed with that key and none from Steam.");
        }
        test.unwrap_or(STEAM_KEY)
    })
}

/// At most one line a minute for each reason, as anyone who reaches the port can send these, and those must not hide the
/// reason that keeps real players out.
fn say_refused(why: Refused, now_s: u64) {
    static LAST_MINUTE: [AtomicU64; 10] = [const { AtomicU64::new(0) }; 10];
    let minute = now_s / 60;
    if LAST_MINUTE[why as usize].swap(minute, Ordering::Relaxed) != minute {
        println!("Refused a sign-in: {}", why.words());
    }
}

fn check(ticket: &str, key: &Key, now_s: u64) -> Result<u64, Refused> {
    if ticket.len() > MOST_BYTES * 2 {
        return Err(Refused::NotATicket);
    }
    let bytes = decode(ticket).ok_or(Refused::NotATicket)?;
    let (signed, signature) = parts(&bytes).ok_or(Refused::NotATicket)?;
    if !signed_with(key, signed, signature) {
        return Err(Refused::NotSigned);
    }
    let read = || -> Option<(u32, u64, u32, u32)> { Some((u32_at(signed, VERSION_AT)?, u64_at(signed, STEAM_ID_AT)?, u32_at(signed, APP_AT)?, u32_at(signed, EXPIRES_AT)?)) };
    let (version, id, app, expires) = read().ok_or(Refused::NotATicket)?;
    if version != VERSION {
        return Err(Refused::NewLayout);
    }
    // an individual account in the public universe
    if id >> 32 != 0x0110_0001 {
        return Err(Refused::NotATicket);
    }
    if u64_at(&bytes, 12) != Some(id) {
        return Err(Refused::TwoPlayers);
    }
    if app != SCREEPS {
        return Err(Refused::OtherGame);
    }
    if u64::from(expires) + CLOCK_SLACK_S < now_s {
        return Err(Refused::Expired);
    }
    Ok(id)
}

/// The signed part and its signature. The lengths around them have to add up, so nothing can sit between the two.
fn parts(ticket: &[u8]) -> Option<(&[u8], &[u8])> {
    let rest = ticket.get(SIGNED_AT..)?;
    if u32_at(ticket, 0)? != 20 || u32_at(ticket, 24)? != 24 || u32_at(ticket, 52)? as usize != rest.len() {
        return None;
    }
    let (signed, signature) = rest.split_at_checked(u32_at(rest, 0)? as usize)?;
    (signature.len() == SIZE).then_some((signed, signature))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

fn decode(hex: &str) -> Option<Vec<u8>> {
    let digit = |b: &u8| char::from(*b).to_digit(16).map(|d| d as u8);
    hex.as_bytes().chunks(2).map(|pair| match pair {
        [high, low] => Some(digit(high)? << 4 | digit(low)?),
        _ => None,
    }).collect()
}

/// Whether `signature` is `key`'s, for `message`. The whole block is compared, so nothing in it is left to a forger.
fn signed_with(key: &Key, message: &[u8], signature: &[u8]) -> bool {
    let (modulus, signature) = (number(key), number(signature));
    if !below(&signature, &modulus) {
        return false;
    }
    let mut recovered = [0; SIZE];
    for (at, word) in power(&signature, EXPONENT, &modulus).iter().rev().enumerate() {
        recovered[at * 4..at * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    recovered == padded(message)
}

/// `00 01 ff.. 00`, then the prefix and the hash: what an RSA signature of `message` turns into.
fn padded(message: &[u8]) -> Key {
    let mut block = [0xff; SIZE];
    let (start, hash) = block.split_at_mut(SIZE - 20);
    let (start, prefix) = start.split_at_mut(SIZE - 20 - SHA1_PREFIX.len());
    start[0] = 0;
    start[1] = 1;
    start[start.len() - 1] = 0;
    prefix.copy_from_slice(&SHA1_PREFIX);
    hash.copy_from_slice(&util::sha1::sha1(message));
    block
}

/// From the big-endian bytes RSA numbers are written in. `bytes` is `SIZE` long.
fn number(bytes: &[u8]) -> Number {
    let mut out = [0; SIZE / 4];
    for (word, chunk) in out.iter_mut().rev().zip(bytes.chunks_exact(4)) {
        *word = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
    }
    out
}

fn below(a: &Number, b: &Number) -> bool {
    a.iter().rev().lt(b.iter().rev())
}

fn subtract(a: &mut Number, b: &Number) {
    let mut borrow = false;
    for (x, y) in a.iter_mut().zip(b) {
        let (less, first) = x.overflowing_sub(*y);
        let (less, second) = less.overflowing_sub(u32::from(borrow));
        *x = less;
        borrow = first || second;
    }
}

/// `a += b`, mod `m`, for `a` and `b` below `m`.
fn add(a: &mut Number, b: &Number, m: &Number) {
    let mut carry = 0;
    for (x, y) in a.iter_mut().zip(b) {
        let sum = u64::from(*x) + u64::from(*y) + carry;
        *x = sum as u32;
        carry = sum >> 32;
    }
    if carry != 0 || !below(a, m) {
        subtract(a, m);
    }
}

/// `a * b`, mod `m`, by doubling and adding: slow by RSA's standards and plenty for one exponent of 17.
fn times(a: &Number, b: &Number, m: &Number) -> Number {
    let mut result = [0; SIZE / 4];
    for word in b.iter().rev() {
        for bit in (0..32).rev() {
            let once = result;
            add(&mut result, &once, m);
            if word >> bit & 1 == 1 {
                add(&mut result, a, m);
            }
        }
    }
    result
}

fn power(base: &Number, exponent: u32, m: &Number) -> Number {
    let mut result = *base;
    for bit in (0..exponent.ilog2()).rev() {
        result = times(&result, &result, m);
        if exponent >> bit & 1 == 1 {
            result = times(&result, base, m);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key made for these tests alone, with the exponent 17 like Steam's, and its private half.
    const N: &str = "cd4769607937ed71ec410921873a089971dab0c1042a01bc495361c18e584291df6e647c44eb6e4a897e83f8c94b22396c163b7adbcf0bef8d154a5f64a5f922951a5249883cf37a74ea0032ff46c09fd2ad3b5d32b73d3b44f9421f9586b0cc64fabe95454cff1eda49179eb7045b07cb65e1e3638fc5790750cd861f9b928d";
    const D: &str = "6cad55e7c7b432697d135f2fde2dc8513c4699cf98caf1dc26d1ca57697a05200ce017149cf51c459415cd6597be5d69b1b16ac8927cabf74ab0eb2371850b6bb5796c0a81db8232943d38ad3e13030acdf1cde535730ffa83357d4401cf1fd77c44e872037c07f13548bb930b4166a1651c8042be2802798fb6a84b20a86f91";
    const ID: u64 = 76561197960287930;
    const NOW: u64 = 1_800_000_000;
    const EXPIRES: u32 = 1_800_100_000;

    fn test_key() -> Key {
        decode(N).unwrap().try_into().unwrap()
    }

    fn signature_of(block: &Key) -> Vec<u8> {
        let (m, d) = (number(&test_key()), number(&decode(D).unwrap()));
        let block = number(block);
        let mut result = [0; SIZE / 4];
        result[0] = 1;
        for word in d.iter().rev() {
            for bit in (0..32).rev() {
                result = times(&result, &result, &m);
                if word >> bit & 1 == 1 {
                    result = times(&result, &block, &m);
                }
            }
        }
        result.iter().rev().flat_map(|w| w.to_be_bytes()).collect()
    }

    /// The signed part of a ticket, with one licence.
    fn signed_part(id: u64, app: u32, expires: u32) -> Vec<u8> {
        let mut part = vec![];
        part.extend(0u32.to_le_bytes()); // its length, below
        part.extend(VERSION.to_le_bytes());
        part.extend(id.to_le_bytes());
        part.extend(app.to_le_bytes());
        part.extend([0u8; 8]); // addresses
        part.extend(0u32.to_le_bytes());
        part.extend((expires - 1_814_400).to_le_bytes()); // made
        part.extend(expires.to_le_bytes());
        part.extend(1u16.to_le_bytes());
        part.extend(7u32.to_le_bytes());
        part.extend(0u16.to_le_bytes());
        part.extend(0u16.to_le_bytes());
        let length = part.len() as u32;
        part[..4].copy_from_slice(&length.to_le_bytes());
        part
    }

    fn wrapped(outer_id: u64, signed: &[u8], signature: &[u8]) -> Vec<u8> {
        let mut t = vec![];
        t.extend(20u32.to_le_bytes());
        t.extend([9u8; 8]);
        t.extend(outer_id.to_le_bytes());
        t.extend(0u32.to_le_bytes());
        t.extend(24u32.to_le_bytes());
        t.extend([0u8; 24]);
        t.extend(((signed.len() + signature.len()) as u32).to_le_bytes());
        t.extend(signed);
        t.extend(signature);
        t
    }

    fn signed_ticket(id: u64, app: u32, expires: u32) -> Vec<u8> {
        let part = signed_part(id, app, expires);
        wrapped(id, &part, &signature_of(&padded(&part)))
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn checked(bytes: &[u8]) -> Result<u64, Refused> {
        check(&hex(bytes), &test_key(), NOW)
    }

    #[test]
    fn a_signed_ticket_gives_its_steam_id() {
        assert_eq!(checked(&signed_ticket(ID, SCREEPS, EXPIRES)), Ok(ID));
    }

    #[test]
    fn only_the_key_that_signed_it_will_do() {
        let ticket = hex(&signed_ticket(ID, SCREEPS, EXPIRES));
        assert_eq!(check(&ticket, &STEAM_KEY, NOW), Err(Refused::NotSigned));
    }

    #[test]
    fn a_made_up_ticket_is_refused() {
        let mut only_the_id = vec![20u8, 0, 0, 0];
        only_the_id.extend([0u8; 8]);
        only_the_id.extend(ID.to_le_bytes());
        assert_eq!(checked(&only_the_id), Err(Refused::NotATicket), "what any ticket used to need");
        let part = signed_part(ID, SCREEPS, EXPIRES);
        assert_eq!(checked(&wrapped(ID, &part, &[0; SIZE])), Err(Refused::NotSigned));
        assert_eq!(checked(&wrapped(ID, &part, &[0xff; SIZE])), Err(Refused::NotSigned), "a signature above the modulus");
    }

    #[test]
    fn every_signed_byte_counts() {
        let ticket = signed_ticket(ID, SCREEPS, EXPIRES);
        for at in SIGNED_AT..ticket.len() {
            let mut changed = ticket.clone();
            changed[at] ^= 1;
            assert!(checked(&changed).is_err(), "byte {at}");
        }
    }

    #[test]
    fn another_players_id_outside_the_signature_is_refused() {
        let part = signed_part(ID, SCREEPS, EXPIRES);
        let ticket = wrapped(ID + 1, &part, &signature_of(&padded(&part)));
        assert_eq!(checked(&ticket), Err(Refused::TwoPlayers));
    }

    #[test]
    fn it_has_to_be_for_this_game_and_still_good() {
        assert_eq!(checked(&signed_ticket(ID, 570, EXPIRES)), Err(Refused::OtherGame));
        let just_out = (NOW - CLOCK_SLACK_S) as u32;
        assert_eq!(checked(&signed_ticket(ID, SCREEPS, just_out)), Ok(ID), "the host's clock may be a little ahead");
        assert_eq!(checked(&signed_ticket(ID, SCREEPS, just_out - 1)), Err(Refused::Expired));
    }

    #[test]
    fn a_game_server_or_clan_id_is_no_player() {
        assert_eq!(checked(&signed_ticket(0x0170_0001_0000_0001, SCREEPS, EXPIRES)), Err(Refused::NotATicket));
    }

    #[test]
    fn a_layout_this_does_not_know_is_refused_even_when_signed() {
        let mut part = signed_part(ID, SCREEPS, EXPIRES);
        part[VERSION_AT] = 5;
        assert_eq!(checked(&wrapped(ID, &part, &signature_of(&padded(&part)))), Err(Refused::NewLayout));
    }

    #[test]
    fn a_short_signed_part_has_nothing_to_read() {
        let part = 8u32.to_le_bytes().iter().chain(&VERSION.to_le_bytes()).copied().collect::<Vec<u8>>();
        assert_eq!(checked(&wrapped(ID, &part, &signature_of(&padded(&part)))), Err(Refused::NotATicket));
    }

    #[test]
    fn a_ticket_cut_short_anywhere_is_refused() {
        let ticket = signed_ticket(ID, SCREEPS, EXPIRES);
        for end in 0..ticket.len() {
            assert!(checked(&ticket[..end]).is_err(), "cut at {end}");
        }
    }

    #[test]
    fn lengths_that_lie_are_refused() {
        let ticket = signed_ticket(ID, SCREEPS, EXPIRES);
        for at in [0, 24, 52, SIGNED_AT] {
            for value in [0, 1, u32::MAX, u32::MAX - 3] {
                let mut lying = ticket.clone();
                lying[at..at + 4].copy_from_slice(&value.to_le_bytes());
                assert!(checked(&lying).is_err(), "{value} at {at}");
            }
        }
    }

    #[test]
    fn bytes_after_the_signature_are_refused() {
        let mut ticket = signed_ticket(ID, SCREEPS, EXPIRES);
        ticket.push(0);
        assert_eq!(checked(&ticket), Err(Refused::NotATicket));
    }

    #[test]
    fn padding_that_is_not_the_exact_block_is_refused() {
        let part = signed_part(ID, SCREEPS, EXPIRES);
        let mut block = padded(&part);
        block[2] = 0; // the padding ends early, and the rest would hold whatever a forger likes
        assert_eq!(checked(&wrapped(ID, &part, &signature_of(&block))), Err(Refused::NotSigned));
    }

    #[test]
    fn what_is_not_hex_is_refused() {
        for text in ["", "0", "zz", "é", "00é", "0é0", "+1", "\u{1F980}\u{1F980}"] {
            assert_eq!(check(text, &test_key(), NOW), Err(Refused::NotATicket), "{text:?}");
        }
        let long = "0".repeat(MOST_BYTES * 2 + 2);
        assert_eq!(check(&long, &test_key(), NOW), Err(Refused::NotATicket));
    }

    #[test]
    fn the_numbers_work_across_words() {
        let mut m = [0; SIZE / 4];
        m[1] = 1; // 2^32
        let mut a = [0; SIZE / 4];
        a[0] = 0xffff_ffff;
        assert_eq!(times(&a, &a, &m)[0], 1, "(2^32 - 1)^2 is 1 mod 2^32");
        let mut b = a;
        add(&mut b, &a, &m);
        assert_eq!(b[..2], [0xffff_fffe, 0], "a sum over the modulus comes back under it");
        let mut m = [0xffff_ffff; SIZE / 4];
        m[0] -= 1;
        let mut highest = m;
        highest[0] -= 1;
        let mut sum = highest;
        add(&mut sum, &highest, &m);
        let mut expected = m;
        expected[0] -= 2;
        assert_eq!(sum, expected, "a carry out of the top word still comes back under the modulus");
    }

    #[test]
    fn every_refusal_has_a_line_of_its_own_to_count() {
        assert!((Refused::TooMany as usize) < 10);
    }

    /// A real ticket holds its owner's addresses and cannot be scrubbed, as they are signed, so it stays out of the
    /// repository. Set KREBS_REAL_TICKET to a file with one in hex, and run this with --ignored. Nothing else here would
    /// notice a wrong byte in `STEAM_KEY` or a wrong offset.
    #[test]
    #[ignore]
    fn a_real_ticket_passes_with_steams_own_key() {
        let ticket = std::fs::read_to_string(std::env::var("KREBS_REAL_TICKET").unwrap()).unwrap();
        let now_s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(check(ticket.trim(), &STEAM_KEY, now_s).is_ok());
    }

    #[test]
    fn steam_has_to_agree_about_the_same_player() {
        assert_eq!(verdict(Answer::Good(ID), ID), Ok(()));
        assert_eq!(verdict(Answer::Good(ID + 1), ID), Err(Refused::SteamSaidNo));
        assert_eq!(verdict(Answer::Bad, ID), Err(Refused::SteamSaidNo));
    }

    #[test]
    fn when_steam_cannot_say_the_answer_is_no() {
        assert_eq!(verdict(Answer::NoAnswer, ID), Err(Refused::NoAnswer));
        assert_eq!(verdict(Answer::KeyRefused, ID), Err(Refused::KeyRefused));
    }

    #[test]
    fn one_ticket_sent_again_and_again_is_one_question_a_gap() {
        let (mut taken, now) = (BTreeMap::new(), Instant::now());
        assert!(take_turn(&mut taken, ID, now));
        assert!(!take_turn(&mut taken, ID, now), "while Steam is asked");
        assert!(!take_turn(&mut taken, ID, now + ASK_GAP - Duration::from_millis(1)), "or just said no");
        assert!(take_turn(&mut taken, ID, now + ASK_GAP));
    }

    #[test]
    fn a_turn_held_by_one_player_is_not_held_against_another() {
        let (mut taken, now) = (BTreeMap::new(), Instant::now());
        assert!(take_turn(&mut taken, ID, now));
        assert!(take_turn(&mut taken, ID + 1, now));
    }

    #[test]
    fn players_asked_about_at_once_have_a_limit() {
        let (mut taken, now) = (BTreeMap::new(), Instant::now());
        assert!((0..MOST_ASKED as u64).all(|i| take_turn(&mut taken, ID + i, now)));
        assert!(!take_turn(&mut taken, ID + MOST_ASKED as u64, now));
        taken.remove(&ID);
        assert!(take_turn(&mut taken, ID + MOST_ASKED as u64, now), "a yes gives its turn back");
        assert!(take_turn(&mut BTreeMap::from([(ID, now - Duration::from_secs(1))]), ID, now), "a turn left behind runs out");
    }

    #[test]
    fn a_wait_outlasts_the_gap_so_a_second_try_gets_its_turn() {
        assert!(TURN_WAIT > ASK_GAP);
    }

    #[test]
    fn numbers_are_read_big_endian() {
        let bytes: Vec<u8> = (0..SIZE as u8).collect();
        let n = number(&bytes);
        assert_eq!((n[SIZE / 4 - 1], n[0]), (0x0001_0203, 0x7c7d_7e7f));
    }
}
