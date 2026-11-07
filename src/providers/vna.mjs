// One official VNA price-reference source; itinerary inventories are not inferred.
import {queryId as identity} from './vna-core.mjs';
import {SOURCE} from './vna-official.mjs';
export {queryFrom,shiftDate} from './vna-core.mjs';
export const queryId=(query,source=SOURCE)=>identity(query,source);
export * from './vna-official.mjs';
