#!/usr/bin/env node
'use strict';
/*
 * Writes capacitor.config.json from environment variables so the same shell can point at staging
 * or production without editing files:
 *   INKWELL_APP_URL   https://inkwell.example.com   (required: the deployed web app)
 *   INKWELL_APP_ID    com.inkwell.app               (bundle id / application id)
 *   INKWELL_APP_NAME  Inkwell
 */
const fs = require('fs');
const path = require('path');

const url = process.env.INKWELL_APP_URL || 'https://inkwell.example.com';
if (!/^https:\/\//.test(url)) {
  console.error('INKWELL_APP_URL must be an https:// URL. App stores reject cleartext traffic and Capacitor blocks it by default.');
  process.exit(1);
}
const config = {
  appId: process.env.INKWELL_APP_ID || 'com.inkwell.app',
  appName: process.env.INKWELL_APP_NAME || 'Inkwell',
  webDir: 'www',
  // The shell loads the deployed web app so releases do not need an app store update.
  server: { url, cleartext: false, allowNavigation: [new URL(url).host, 'checkout.stripe.com'] },
  ios: { contentInset: 'automatic', limitsNavigationsToAppBoundDomains: false },
  android: { allowMixedContent: false, backgroundColor: '#0e0e10' },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
fs.writeFileSync(path.join(__dirname, 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`capacitor.config.json written for ${config.appId} -> ${url}`);
