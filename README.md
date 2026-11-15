# Sound Panel

A Vencord plugin that adds an advanced sound panel to Discord's voice controls, next to the camera, screen share, activities and soundboard buttons.

## Features

- **Soundboard tab**: every soundboard sound you can access (favorites, each server, Discord defaults), with search and collapsible groups. When Discord's soundboard is allowed in the channel, sounds play through it. When it isn't (missing permission, no Nitro for other servers' sounds), they play through your microphone instead, marked with a mic badge. You can also force every server sound through your microphone in the settings. Right-click a sound to pick the route, preview it, or save a copy to your library.
- **My Sounds tab**: upload your own sound effects (click **Add** or drag and drop). Click to play them into your microphone. Right-click to play only for yourself, change the volume, rename, move to Music or delete.
- **Music tab**: a playlist player with play/pause, previous/next, seek, shuffle, repeat (all / one / off) and its own volume.
- **Footer mixer**: choose whether your audio goes to the voice channel or stays local, set the volume others hear and the volume you hear, stop everything, and see a live status that explains why others can't hear you when something is wrong.

Your files never leave your computer. On the desktop app they're kept in Vencord's data folder (`%APPDATA%\Vencord\SoundPanel` on Windows), so Discord Stable, PTB and Canary share one library; sounds added before this are moved there automatically. In the browser they're kept in IndexedDB.

## How others hear your own sounds

Server soundboard sounds use Discord's own soundboard, so everyone hears them.

Your uploaded sounds and music are mixed into your microphone stream. This only works when Discord uses its **WebRTC** voice engine:

- **Browser / Vesktop**: works out of the box.
- **Discord desktop app**: the default native voice engine captures the microphone outside of JavaScript, so enable **"Use Discord's WebRTC voice engine"** in the plugin settings and restart Discord. In this mode SoundPanel also makes screen sharing work: Go Live opens SoundPanel's own screen/window picker, and shared audio leaves out Discord's own playback so people in the call don't hear themselves. Video is encoded with VP8, since the Chromium inside Discord's desktop app has no H264 encoder. With **"maximum video quality"** (on by default) your camera is sent at its best resolution and frame rate and your stream at exactly the quality you pick, at the highest bitrate Discord allows, instead of being shrunk to viewers' window sizes.

Tips:
- Turn off Krisp noise suppression for the best music quality, since it filters out non-voice audio.
- With Push to Talk, the plugin keeps you transmitting while your audio plays (configurable).
- If you joined voice before enabling the plugin, rejoin the channel so your microphone gets mixed.

## Structure

```
SoundPanel/
├── index.tsx              Plugin definition and patches
├── settings.ts            Plugin settings
├── styles.css
├── audio/
│   ├── mixer.ts           Audio graph and microphone mixing
│   └── player.ts          Sound effect and music playback
├── data/
│   └── library.ts         Local storage for your files
├── discord/
│   └── soundboard.ts      Discord soundboard integration
├── components/            UI (button, popout, tabs, menus, icons)
└── utils/
    └── store.ts           Small state store and helpers
```

## License

GPL-3.0-or-later
