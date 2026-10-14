import type { NextConfig } from 'next';

const config: NextConfig = {
  // postgres-js opens sockets; keep it out of the server bundle.
  serverExternalPackages: ['postgres'],
  webpack(cfg) {
    // src/ uses NodeNext-style ".js" import specifiers for .ts files.
    cfg.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return cfg;
  },
};

export default config;
