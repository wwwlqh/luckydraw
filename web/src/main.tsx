// Entry point. Nothing runs before the CSP-governed module loads, and no script is inline (SPEC §9.6).

import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {App} from "./app/App.tsx";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The #root element is missing from index.html.");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
