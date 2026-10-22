/**
 * Entry point of dist/net.js: the WebRTC layer is about a hundred kilobytes, so it is built as a
 * separate file and loaded only when someone opens a table with friends (see App.#room).
 */
import { trysteroRoom } from './trystero-room.ts';

(globalThis as { __velvetNet?: { trysteroRoom: typeof trysteroRoom } }).__velvetNet = { trysteroRoom };
