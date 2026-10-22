import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MainWindow } from "./MainWindow";
import { Overlay } from "./Overlay";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (!window.lumen) {
  root.render(<div className="empty">Lumen must be opened from the desktop app.</div>);
} else {
  const overlay = window.lumen.role === "overlay";
  root.render(
    <StrictMode>
      <ErrorBoundary compact={overlay} onCrash={(r) => void window.lumen.reportCrash(r)}>
        {overlay ? <Overlay /> : <MainWindow />}
      </ErrorBoundary>
    </StrictMode>,
  );
}
