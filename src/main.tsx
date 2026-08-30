import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its dev-only double-invoke of effects doesn't play well
// with this app's native, singleton window-event subscriptions (close
// requests, keyboard shortcuts) — async setup + cleanup racing across the
// mount/unmount/remount cycle can leave a stale listener registered
// alongside the new one. It's a no-op in production builds either way.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
