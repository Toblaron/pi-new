import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * No component in this app validates AI-derived JSON at runtime before rendering it (backend
 * routes don't schema-validate LLM output either — see routes/suno.ts's reverse/mood-to-settings
 * handlers) — a malformed or unexpectedly-null field can throw mid-render. Without this, that
 * throw unmounts the entire app to a blank white screen with no way to recover short of a manual
 * reload. This won't isolate the failure to just the panel that caused it (that would need a
 * boundary per panel, a much larger change) — it just guarantees there's always a fallback UI
 * with a way out, instead of nothing at all.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <div className="max-w-md w-full border border-red-500/30 bg-red-500/5 p-6 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto" />
            <p className="font-mono text-sm text-zinc-200">Something went wrong.</p>
            <p className="font-mono text-xs text-zinc-500">
              {this.state.error.message || "An unexpected error occurred while rendering the page."}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 px-4 py-2 font-mono text-xs uppercase tracking-wider border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
