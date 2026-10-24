# Quack Studio plugin

The plugin side of the sync. It connects to the Quack hub (Official on port 3825, Dev on 3826),
sends the place's instances and every change, and applies the scripts the disk changes.

## Build and install

```
node plugin/scripts/build-rbxmx.mjs          # Official: writes Plugins/Quack.rbxmx (port 3825)
node plugin/scripts/build-rbxmx.mjs --dev    # Dev: writes Plugins/QuackDev.rbxmx (port 3826)
```

Both go straight into Studio's local plugins folder. A local plugin loads when a place opens:
reopen the place to run a new build. Check the Luau first with `luau-lsp analyze`.

## Layout

- `sync/ReplicatedFirst/QuackPlugin.server.luau`: the entry script
- `sync/ReplicatedFirst/QuackPlugin/`: the session (`SyncSession.luau`), the instance walker and
  serializer (`QuackService.luau`, `Serializer.luau`), settings, and the UI under `App/`
- `Packages/` (Fusion) and `Vendor/` (rbx-dom) are third-party code, kept as published.
  `npm run vendor:rbx-dom-lua` refreshes rbx-dom with `quack push`.

## Using it

- With "Connect on its own" on, the plugin connects whenever a registered place opens.
- "Sync this place" off: that place never connects and shows no Quack pop-ups.
- A place the hub does not know shows a pop-up with "Ignore this place"; registering it is done
  in the Quack app (Settings > Add folder).
- Playtest output reaches the app's Playtest tab with "Playtest output" on.
