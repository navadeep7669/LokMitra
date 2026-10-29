import { Component, type ReactNode } from 'react';

export class PortalErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="portal-crash"><h1>We could not load this portal.</h1><p>Your local records have not been deleted. Reload to try again.</p><button className="button button-primary" onClick={() => window.location.reload()}>Reload portal</button></main>;
    return this.props.children;
  }
}
