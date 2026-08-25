#!/usr/bin/env node
import { main } from '../src/orchestratorCli.js';

await main(process.argv.slice(2));
