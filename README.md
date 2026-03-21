# Squeetboard

A Windows soundboard application built with Electron and Next.js, designed for use with virtual audio cables (like VB-CABLE) to route audio to voice chat applications.

## Features

- **Sound Library Management**: Organize sounds into categories, search, and manage your collection
- **Virtual Audio Cable Support**: Route audio to any output device including virtual audio cables
- **Global Hotkeys**: Assign hotkeys to sounds for quick playback from anywhere
- **Waveform Visualization**: View and trim sounds with a visual waveform editor
- **System Tray Integration**: Minimize to tray, control playback from tray menu
- **Drag and Drop**: Import sounds by dragging files into the app

## Requirements

- Windows 10 or later
- Node.js 18+ (for development)
- Optional: Virtual Audio Cable (VB-CABLE, Virtual Audio Cable, etc.) for routing audio to other apps

## Installation

### Development

```powershell
# Clone or navigate to the project
cd C:\Programming\Squeetboard

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Building for Production

```powershell
# Build the application
npm run build

# Create distributable (NSIS installer + portable)
npm run dist

# Or create unpacked directory for testing
npm run pack
```

The built application will be in the `dist` folder.

## Usage

### Adding Sounds

1. **Drag and Drop**: Drag audio files (MP3, WAV, OGG, FLAC, M4A, WebM) directly into the app
2. **File Picker**: Click "Add Sounds" in the sidebar and select files

### Managing Categories

- Click "Add Category" in the sidebar to create a new category
- Right-click a category to rename or delete it
- Assign sounds to categories in the sound editor

### Editing Sounds

Right-click a sound and select "Edit" to:
- Rename the sound
- Set a custom thumbnail image
- Assign a global hotkey
- Adjust volume
- Trim the sound using the waveform editor (set start/end points)

### Audio Output

1. Select your desired output device from the dropdown in the bottom bar
2. For virtual audio cable usage:
   - Select your virtual cable (e.g., "CABLE Input") as the output device in Squeetboard
   - In Discord/other apps, set the virtual cable output (e.g., "CABLE Output") as your microphone input

### Global Hotkeys

- **Stop All Sounds**: Default is `Ctrl+Shift+Space` (configurable in Settings)
- **Sound Hotkeys**: Assign individual hotkeys to sounds in the sound editor

### System Tray

- The app minimizes to the system tray when closed (configurable in Settings)
- Double-click the tray icon to show the window
- Right-click for quick actions (Show, Stop All, Quit)

## Project Structure

```
C:\Programming\Squeetboard
├── electron/          # Electron main process
│   ├── main.ts       # Main process entry
│   └── preload.ts    # Preload script (IPC bridge)
├── src/              # Next.js renderer
│   ├── app/          # App Router pages
│   ├── components/   # React components
│   ├── lib/          # Stores and utilities
│   └── hooks/        # Custom hooks
├── shared/           # Shared TypeScript types
├── build/            # Build resources (icons)
├── out/              # Next.js static export (generated)
└── dist/             # Packaged application (generated)
```

## Configuration

User data is stored in:
```
%APPDATA%\squeetboard\squeetboard-data\
├── squeetboard.db    # SQLite database
├── sounds/           # Imported sound files
└── thumbnails/       # Sound thumbnail images
```

## Audio Device Limitations

The Web Audio API's `setSinkId()` method is used for audio device selection. This works in most Chromium-based environments but may have limitations:

- Some virtual audio devices may not appear in the device list
- If a device doesn't appear, set it as your Windows default output device as a workaround
- Device changes take effect on the next sound played

## Troubleshooting

### Sounds not playing
- Check that the selected output device is valid
- Ensure the sound file is not corrupted
- Try restarting the application

### Hotkeys not working
- Ensure the hotkey isn't already registered by another application
- Try a different key combination
- Run the app as administrator if system-wide hotkeys are blocked

### Virtual audio cable not showing
- Install/reinstall your virtual audio cable software
- Check Windows Sound settings to ensure the device is enabled
- Click the refresh button next to the device dropdown

## Development Notes

- Uses SQLite (better-sqlite3) for local persistence
- Audio playback via Web Audio API with device selection support
- Global hotkeys via Electron's globalShortcut API
- Frameless window with custom title bar

## License

MIT
