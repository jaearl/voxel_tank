// Desktop shell: opens the game in its own window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

// Make sure the dedicated GPU is used and not blocklisted.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force_high_performance_gpu');

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    title: 'Voxel Tank',
    backgroundColor: '#0d1114',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win.show());

  // F11 = fullscreen, F12 = dev tools (for debugging)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); event.preventDefault(); }
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
