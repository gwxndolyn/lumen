import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MainWindow } from "./MainWindow";
import { Overlay } from "./Overlay";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (!window.lumen) {
  root.render(<div className="empty">Lumen must be opened from the desktop app.</div>);
} else {
  root.render(<StrictMode>{window.lumen.role === "overlay" ? <Overlay /> : <MainWindow />}</StrictMode>);
}
