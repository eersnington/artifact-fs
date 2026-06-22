import "@cloudflare/kumo/styles/standalone";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./dashboard.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Dashboard root element was not found. The page was not mounted; reload the dashboard HTML and check the static asset build.");
}

createRoot(root).render(<App />);
