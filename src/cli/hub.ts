#!/usr/bin/env node
import { VERSION } from '../core/version.js';

const HELP = `reinstall-hub ${VERSION}: the layer that connects every project's brain.

Usage: reinstall-hub <command> [options]

Commands arrive in a later phase: index, inbox, priorities, place.
  version           Print the version
`;

const [cmd] = process.argv.slice(2);
if (cmd === 'version' || cmd === '--version') console.log(VERSION);
else process.stdout.write(HELP);
