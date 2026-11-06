//! Players' pictures, as they are on Steam: the animated avatar and its frame, or the plain avatar. Steam's public profile
//! XML and item list need no API key. std has no TLS, so curl fetches them, away from the requests that want them: a poll
//! gets what is already known, and a new player's picture appears a poll or two later.

use backend::http::obj;
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use util::json::Json;

/// A picture changes rarely, and Steam is asked per player.
const REFRESH: Duration = Duration::from_secs(600);
/// Fetches at once. Each is a thread and two curl processes, and new players can turn up faster than Steam answers.
const MAX_FETCHES: usize = 4;
/// Where the relative image paths of Steam's profile items live.
const ITEM_IMAGES: &str = "https://shared.fastly.steamstatic.com/community_assets/images/";

#[derive(Clone, Default, PartialEq, Debug)]
pub(crate) struct Picture {
    pub avatar: Option<String>,
    pub frame: Option<String>,
}

struct Known {
    picture: Picture,
    asked: Instant,
}

static KNOWN: Mutex<BTreeMap<String, Known>> = Mutex::new(BTreeMap::new());
static FETCHES: AtomicUsize = AtomicUsize::new(0);

/// One of the `MAX_FETCHES`, for as long as this lives.
struct FetchSlot;

impl FetchSlot {
    fn take() -> Option<FetchSlot> {
        FETCHES.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| (n < MAX_FETCHES).then_some(n + 1)).ok().map(|_| FetchSlot)
    }
}

impl Drop for FetchSlot {
    fn drop(&mut self) {
        FETCHES.fetch_sub(1, Ordering::Relaxed);
    }
}

/// What is known of a SteamID64 (digits only), and a fetch in the background if that is nothing or it is old.
pub(crate) fn picture(steam_id: &str) -> Picture {
    let mut known = KNOWN.lock().unwrap();
    if let Some(k) = known.get(steam_id).filter(|k| k.asked.elapsed() < REFRESH) {
        return k.picture.clone();
    }
    if steam_id.is_empty() || !steam_id.bytes().all(|b| b.is_ascii_digit()) {
        return Picture::default();
    }
    let held = known.get(steam_id).map(|k| k.picture.clone()).unwrap_or_default();
    // with none free nothing is written down, so a later poll asks again
    let Some(slot) = FetchSlot::take() else { return held };
    known.insert(steam_id.to_string(), Known { picture: held.clone(), asked: Instant::now() });
    let id = steam_id.to_string();
    let _ = std::thread::Builder::new().spawn(move || {
        let _slot = slot;
        if let Some(found) = fetch(&id) {
            if let Some(k) = KNOWN.lock().unwrap().get_mut(&id) {
                k.picture = found;
            }
        }
    });
    held
}

impl Picture {
    /// The fields a seat carries in a reply.
    pub fn fields(&self) -> Vec<(&'static str, Json)> {
        let text = |v: &Option<String>| v.clone().map_or(Json::Null, Json::Str);
        vec![("avatar", text(&self.avatar)), ("frame", text(&self.frame))]
    }
}

fn curl(url: &str) -> Option<String> {
    run_curl("curl", url)
}

/// Nothing at all when curl is missing, fails or times out: a player then keeps the plain picture, and the output of
/// both streams stays here, so nothing reaches the console.
fn run_curl(program: &str, url: &str) -> Option<String> {
    let out = Command::new(program).args(["-sSfL", "--proto", "=https", "--max-time", "5", "--max-filesize", "1000000"]).arg(url).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn fetch(steam_id: &str) -> Option<Picture> {
    let xml = curl(&format!("https://steamcommunity.com/profiles/{steam_id}/?xml=1"))?;
    let avatar = cdata(&xml, "avatarFull").filter(|url| is_avatar_url(url));
    let items = curl(&format!("https://api.steampowered.com/IPlayerService/GetProfileItemsEquipped/v1/?steamid={steam_id}"));
    let (animated, frame) = items.as_deref().map_or((None, None), equipped);
    Some(Picture { avatar: animated.or(avatar), frame })
}

/// `<tag><![CDATA[value]]></tag>`, first occurrence: the profile's own fields come before its groups and games.
fn cdata(xml: &str, tag: &str) -> Option<String> {
    let rest = xml.split_once(&format!("<{tag}><![CDATA["))?.1;
    Some(rest.split_once(&format!("]]></{tag}>"))?.0.to_string()).filter(|v| !v.is_empty())
}

/// The moving versions: `image_small` is the GIF or animated PNG, `image_large` a still.
fn equipped(items: &str) -> (Option<String>, Option<String>) {
    let Ok(items) = Json::parse(items) else { return (None, None) };
    let image = |item: &str, extension: &str| {
        let path = items.get("response")?.get(item)?.get("image_small")?.as_str()?;
        (path.ends_with(extension) && is_item_path(path)).then(|| format!("{ITEM_IMAGES}{path}"))
    };
    (image("animated_avatar", ".gif"), image("avatar_frame", ".png"))
}

fn is_item_path(path: &str) -> bool {
    !path.contains("..") && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

fn is_avatar_url(url: &str) -> bool {
    url.starts_with("https://avatars.") && url.split('/').nth(2).is_some_and(|host| host.ends_with(".steamstatic.com")) && url.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:".contains(&b))
}

/// For a seat's reply, here so the two stay one shape.
pub(crate) fn seat_json(name: &str, color: &str, ready: bool, picture: &Picture) -> Json {
    let mut fields = vec![("name", Json::Str(name.to_string())), ("color", Json::Str(color.to_string())), ("ready", Json::Bool(ready))];
    fields.extend(picture.fields());
    obj(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profiles_own_avatar_comes_before_its_groups() {
        let xml = "<profile><steamID><![CDATA[Neo]]></steamID><avatarFull><![CDATA[https://a/1.jpg]]></avatarFull><groups><avatarFull><![CDATA[https://a/2.jpg]]></avatarFull></groups></profile>";
        assert_eq!(cdata(xml, "avatarFull").as_deref(), Some("https://a/1.jpg"));
        assert_eq!(cdata(xml, "nothing"), None);
    }

    #[test]
    fn equipped_items_give_the_moving_picture_and_frame() {
        let items = r#"{"response":{"animated_avatar":{"image_small":"items/1/a.gif"},"avatar_frame":{"image_small":"items/2/f.png"}}}"#;
        assert_eq!(equipped(items), (Some(format!("{ITEM_IMAGES}items/1/a.gif")), Some(format!("{ITEM_IMAGES}items/2/f.png"))));
        assert_eq!(equipped(r#"{"response":{}}"#), (None, None));
        assert_eq!(equipped(r#"{"response":{"animated_avatar":{"image_small":"../evil.gif"}}}"#).0, None);
        assert_eq!(equipped("not json"), (None, None));
    }

    #[test]
    fn only_steams_own_pictures_are_passed_on() {
        assert!(is_avatar_url("https://avatars.fastly.steamstatic.com/c8148e6e_full.jpg"));
        assert!(!is_avatar_url("https://avatars.example.com/a.jpg"));
        assert!(!is_avatar_url("http://avatars.fastly.steamstatic.com/a.jpg"));
        assert!(!is_avatar_url("https://avatars.fastly.steamstatic.com/a\".jpg"));
    }

    #[test]
    fn a_missing_curl_is_only_a_missing_picture() {
        assert_eq!(run_curl("krebs-no-such-program", "https://example.invalid/"), None);
    }

    #[test]
    fn fetches_at_once_have_a_limit() {
        let held: Vec<FetchSlot> = (0..MAX_FETCHES).filter_map(|_| FetchSlot::take()).collect();
        assert_eq!(held.len(), MAX_FETCHES);
        assert!(FetchSlot::take().is_none());
        assert_eq!(picture("76561197960287930"), Picture::default(), "a new player waits for a slot");
        assert!(!KNOWN.lock().unwrap().contains_key("76561197960287930"), "and is asked about again later");
        drop(held);
        let slot = FetchSlot::take();
        assert!(slot.is_some(), "a slot comes back when its fetch ends");
    }

    #[test]
    fn nothing_is_asked_about_what_is_not_a_steam_id() {
        assert_eq!(picture("not a number"), Picture::default());
        assert_eq!(picture(""), Picture::default());
    }
}
