import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Resolve from this module so every entry point uses the same storage root,
// even when it is launched from another working directory.
export const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const cliPath = (file, root = projectRoot) => path.join(root, 'src', 'cli', file);
