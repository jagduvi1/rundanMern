// Catches render-time errors in its subtree and shows a friendly Swedish fallback
// with a reload button. Errors are logged to the console only in dev
// (import.meta.env.DEV). The one class component in the app — error boundaries
// have no hook equivalent.
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('ErrorBoundary caught an error:', error, info);
    }
  }

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="loading-page">
          <div className="card center" style={{ maxWidth: 420 }}>
            <h2 style={{ marginTop: 0 }}>Något gick fel</h2>
            <p className="muted">
              Ett oväntat fel inträffade. Försök att ladda om sidan.
            </p>
            <button type="button" className="btn" onClick={this.handleReload}>
              Ladda om
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
