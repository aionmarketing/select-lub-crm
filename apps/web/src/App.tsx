/**
 * Root route table for the authenticated CRM shell.
 */
import { Navigate, Route, Routes } from "react-router-dom";
import { appTitle } from "./appTitle.js";
import { ConfiguracoesPage } from "./ConfiguracoesPage.js";
import { ConversasPage } from "./ConversasPage.js";
import { Gallery } from "./Gallery.js";
import { ServicosPage } from "./ServicosPage.js";
import { FollowUpPage } from "./FollowUpPage.js";
import { RelatoriosPage } from "./RelatoriosPage.js";
import { RequireAuth } from "./RequireAuth.js";
import { UsuariosPage } from "./UsuariosPage.js";

/** Re-exported product title for tests and the shell header. */
export { appTitle };

/**
 * Application routes — Conversas inbox at `/`, Serviços at `/servicos`, Follow-up at `/follow-up`, plus reports, settings, users, and the token gallery.
 *
 * `/login` redirects to `/`. Product routes sit behind {@link RequireAuth}.
 *
 * @returns React Router route table for the authenticated CRM shell.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<ConversasPage />} />
        <Route path="/servicos" element={<ServicosPage />} />
        <Route path="/follow-up" element={<FollowUpPage />} />
        <Route path="/relatorios" element={<RelatoriosPage />} />
        <Route path="/configuracoes" element={<ConfiguracoesPage />} />
        <Route path="/usuarios" element={<UsuariosPage />} />
        <Route path="/galeria" element={<Gallery />} />
      </Route>
    </Routes>
  );
}
