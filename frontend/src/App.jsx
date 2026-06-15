// App composition root + router. Mounted by main.jsx (inside HelmetProvider +
// StrictMode), so this file owns the provider stack and the route table only.
//
//   ErrorBoundary > BrowserRouter > BootstrapProvider > AuthProvider > AppRoutes
//
// AppRoutes gates the whole SPA behind the shared access code (when the
// deployment requires one and the device hasn't stored it) by rendering
// <AccessGate/> instead of the routes — the port of rundan's MainLayout access
// gate. Pages are lazy-loaded so each route only pulls its own JS.
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import { LoadingPage } from './components/Spinner';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { BootstrapProvider, useBootstrap } from './contexts/BootstrapContext';
import { AuthProvider } from './contexts/AuthContext';
import AccessGate from './components/AccessGate';

// Lazy pages — derived 1:1 from doc 09's route map.
const Home = lazy(() => import('./pages/Home'));
const Events = lazy(() => import('./pages/Events'));
const Event = lazy(() => import('./pages/Event'));
const Activity = lazy(() => import('./pages/Activity'));
const Manage = lazy(() => import('./pages/Manage'));
const CreateEvent = lazy(() => import('./pages/CreateEvent'));
const Admin = lazy(() => import('./pages/Admin'));
const Users = lazy(() => import('./pages/Users'));
const Diploma = lazy(() => import('./pages/Diploma'));
const SpotifyCallback = lazy(() => import('./pages/SpotifyCallback'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const MagicLink = lazy(() => import('./pages/MagicLink'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Profile = lazy(() => import('./pages/Profile'));
const NotFound = lazy(() => import('./pages/NotFound'));

function AppRoutes() {
  const { loading, needsAccessGate } = useBootstrap();

  // Wait for bootstrap before deciding whether the access gate is needed
  // (fail-closed: never render the app while we don't yet know).
  if (loading) return <LoadingPage label="Laddar…" />;

  // Shared access code required but not yet stored on this device → whole-app gate.
  if (needsAccessGate) {
    return (
      <Layout>
        <AccessGate />
      </Layout>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<LoadingPage />}>
        <Routes>
          {/* Public — players + cold-start launcher */}
          <Route path="/" element={<Home />} />
          <Route path="/events" element={<Events />} />
          <Route path="/e/:id" element={<Event />} />
          <Route path="/a/:id" element={<Activity />} />
          <Route path="/diploma/:id" element={<Diploma />} />
          <Route path="/spotify-callback" element={<SpotifyCallback />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/magic-link" element={<MagicLink />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Any logged-in account (host or invited player) */}
          <Route
            path="/profile"
            element={(
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            )}
          />

          {/* Host-only — requires a logged-in account (replaces rundan's admin code) */}
          <Route
            path="/create"
            element={(
              <ProtectedRoute>
                <CreateEvent />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/create/:eventId"
            element={(
              <ProtectedRoute>
                <CreateEvent />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/admin"
            element={(
              <ProtectedRoute>
                <Admin />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/admin/users"
            element={(
              <ProtectedRoute>
                <Users />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/manage/:id"
            element={(
              <ProtectedRoute>
                <Manage />
              </ProtectedRoute>
            )}
          />

          {/* 404 */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <BootstrapProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BootstrapProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
