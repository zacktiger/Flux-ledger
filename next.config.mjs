import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // There is an unrelated package-lock.json in the user home directory above
  // this project. Without this line Next.js walks up, finds it, and infers the
  // wrong workspace root.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),

  // `pg` is a native-ish Node library; it must not be bundled into the server
  // build or it loses track of its optional native dependencies.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
