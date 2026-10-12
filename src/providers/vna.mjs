// Active source uses the publicly searched agency inventory from Workers and Node.
// The official matrix implementation remains separate for diagnosis only.
import {queryId as identity} from './vna-core.mjs';
import {SOURCE} from './vna-flynow.mjs';
export {queryFrom,shiftDate} from './vna-core.mjs';
export const queryId=(query,source=SOURCE)=>identity(query,source);
export * from './vna-flynow.mjs';
