// What the sections share with app.js, filled in by app.js at startup:
//   S        the state (what the server sends, plus this screen's own things)
//   motor    the core's engine, used here only to read and describe (the server is the one that acts)
//   orden    sends an order to the server: orden({ orden: "vigilar", num }) → Promise<{ ok, toast, error… }>
//   toast    short message at the bottom
//   render   redraw everything (batched to the next frame)
export const ctx = {};
