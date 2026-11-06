# krebs-bare

A mod for Krebs, which is on [GitHub](https://github.com/DefaultO/krebs) and [Gitea](https://gitea.defaul.to/DefaultO/krebs).
Either one is enough. It lives at `mods/bare` in the core, as a git submodule, and it builds only inside the core. To get it:

```
git clone --recursive https://github.com/DefaultO/krebs.git
```

This is what Krebs players see. It strips the stock Screeps Steam client down to a landing page with lobbies and Battle
Royale. Each match runs in a server process of its own, and that server needs the `matchrun` mod, so both have to be built in.

Turn it on with `"mods": ["bare"]` in `krebs.json`, or `krebs serve --mods bare`. `run.bat` does this when the folder is
here, and then page files reload on a reconnect.

Logging in takes the SteamID from the part of the client's ticket that Steam signed, and checks that signature itself. On a
server other people can reach, Steam also has to confirm the ticket is in use, which takes the host's Steam Web API key
(`src/ticket.rs`). Nothing is encrypted, so this mod is not for a public server.

`landing.html`, `landing.js`, `worldmap.js`, `render.js` and `resolve.mjs` are the page. `src/` is the server side:
`lobbies.rs` runs a lobby, `world.rs` runs a match's server, and `steam.rs` fetches players' pictures. `logos/` holds every
logo and what made it. More in `mods/README.md` in the
core.

The code is under the MIT licence, see `LICENSE`. The sprites in `game-assets/` and the fonts are not, see
`THIRD_PARTY_NOTICES.md`.
