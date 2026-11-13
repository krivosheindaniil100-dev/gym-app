import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bodytwin.app',
  appName: 'Body Twin',
  webDir: 'dist',
  backgroundColor: '#07080c',
  android: {
    backgroundColor: '#07080c',
  },
  plugins: {
    CapacitorHttp: { enabled: true },
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#07080c',
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#07080c',
    },
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
