import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage, RequireRole } from './auth/Auth';
import { MerchantPortal } from './portals/MerchantPortal';
import { DeveloperPortal } from './portals/DeveloperPortal';
import { useAuth } from './auth/Auth';
import { PortalErrorBoundary } from './auth/PortalErrorBoundary';

function RootRedirect() {
  const { session } = useAuth();
  return <Navigate to={session ? session.role === 'merchant' ? '/app/dashboard' : '/dev/overview' : '/login'} replace />;
}
export default function PortalApp() {
  return <Routes>
    <Route path="/" element={<RootRedirect />} />
    <Route path="/login" element={<LoginPage />} />
    <Route element={<RequireRole role="merchant" />}>
      <Route path="/app/*" element={<PortalErrorBoundary><MerchantPortal /></PortalErrorBoundary>} />
    </Route>
    <Route element={<RequireRole role="developer" />}>
      <Route path="/dev/*" element={<PortalErrorBoundary><DeveloperPortal /></PortalErrorBoundary>} />
    </Route>
    <Route path="*" element={<RootRedirect />} />
  </Routes>;
}
