import { Component, type ErrorInfo, type ReactNode } from "react";

/** Only the error type and the component stack are reported — never messages, which can contain user text. */
export function crashReport(error: unknown, info: Pick<ErrorInfo, "componentStack">): { name: string; components: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const components = (info.componentStack ?? "")
    .split("\n")
    .map((l) => /at ([A-Z]\w*)/.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .slice(0, 8)
    .join(" < ");
  return { name, components };
}

type Props = { children: ReactNode; onCrash?: (report: ReturnType<typeof crashReport>) => void; compact?: boolean };

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onCrash?.(crashReport(error, info));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert" style={{ padding: this.props.compact ? 16 : 40 }}>
        <h2 style={{ margin: 0 }}>Something went wrong in this window</h2>
        <p className="muted small" style={{ maxWidth: 420 }}>
          Your sessions, conversations and settings are saved and were not affected. Reloading the window usually fixes this; the error type was written to Lumen's log (no content).
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload window
          </button>
          <button className="btn" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
