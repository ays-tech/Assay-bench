// The decision rule lives in web/ so the dashboard can re-decide live when the reader changes
// the quality margin. Node and the browser run the same code.
export * from '../../web/recommend.js';
