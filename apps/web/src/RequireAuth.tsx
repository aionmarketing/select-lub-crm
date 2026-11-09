/**
 * Auth gate and authenticated chrome — header with palette switch and outlet for protected screens.
 */
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { Outlet } from "react-router-dom";
import { appTitle } from "./appTitle.js";
import { LOGIN_FAILED_COPY, useAuthSession } from "./authSession.js";
import { usePalette } from "./paletteStore.js";
import {
  TYPE_SCALE,
  SHELL_BAR_HEIGHT_PX,
  MAIN_CONTENT_ID,
  TOUCH_TARGET_PX,
  type PaletteId,
} from "./theme.js";

/**
 * Blocks child routes until session is ready; shows login failure or the app shell with palette toggle.
 *
 * @returns Loading skeletons while session hydrates, an error alert when login failed, or the header plus `<Outlet>` when authenticated.
 */
export function RequireAuth() {
  const accessToken = useAuthSession((s) => s.accessToken);
  const ready = useAuthSession((s) => s.ready);
  const recovering = useAuthSession((s) => s.recovering);
  const paletteId = usePalette((s) => s.paletteId);
  const setPaletteId = usePalette((s) => s.setPaletteId);
  if (!ready) {
    return (
      <Stack spacing={1} role="status">
        <Skeleton variant="rounded" height={48} />
        <Typography>Carregando…</Typography>
      </Stack>
    );
  }
  // A token is null for two very different reasons, and they must not look the
  // same. Sign-in failed, or a session that was working is being replaced right
  // now. During a recovery the screen stays exactly as it was — the spec's
  // "product routes remain on screen, and no credential form is shown" — because
  // flashing a login failure at someone whose session is about to be restored
  // is both wrong and alarming. Dependent reads are already held off by the
  // null token, so nothing behind this renders stale data.
  if (!accessToken && !recovering) {
    return <Alert severity="error">{LOGIN_FAILED_COPY}</Alert>;
  }
  return (
    <Stack sx={{ minHeight: "100vh" }}>
      <Link
        href={`#${MAIN_CONTENT_ID}`}
        sx={(theme) => ({
          position: "absolute",
          left: theme.spacing(1),
          top: theme.spacing(1),
          zIndex: theme.zIndex.tooltip,
          px: 1.5,
          py: 1,
          minHeight: TOUCH_TARGET_PX,
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          bgcolor: "background.paper",
          color: "text.primary",
          fontWeight: 700,
          borderRadius: 2,
          transform: "translateY(-160%)",
          "&:focus": {
            transform: "none",
            outline: `${theme.spacing(0.25)} solid ${theme.palette.secondary.main}`,
            outlineOffset: theme.spacing(0.25),
          },
        })}
      >
        Pular para o conteúdo
      </Link>
      <AppBar position="static" color="secondary">
        {/* The canvas shell: 52px tall, 24px side padding, 16px gap
            (design/mvp-screen-designs `.shell`). */}
        <Toolbar variant="dense" sx={{ gap: 2, minHeight: SHELL_BAR_HEIGHT_PX, px: 3 }}>
          {/* Non-heading on purpose: Gallery renders the only appTitle heading
              and tests query it by role — a second heading would be ambiguous. */}
          <Typography component="div" sx={{ flexGrow: 1, fontWeight: 800 }}>
            {appTitle}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={paletteId}
            aria-label="Paleta de cores"
            onChange={(_event, next: PaletteId | null) => {
              if (next !== null) {
                setPaletteId(next);
              }
            }}
            sx={{
              bgcolor: "background.paper",
              borderRadius: 1,
              p: "2px",
              gap: "2px",
              // The active option is a FILL of primary with its contrastText,
              // never primary as a foreground: the brand gold sits near 1.9:1
              // on white and fails AA as text or as an icon colour.
              "& .MuiToggleButton-root": {
                border: 0,
                borderRadius: "2px",
                px: 1.5,
                py: 0.5,
                fontSize: TYPE_SCALE.caption,
                fontWeight: 600,
                color: "text.secondary",
                "&.Mui-selected": {
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                  "&:hover": { bgcolor: "primary.main" },
                },
              },
            }}
          >
            <ToggleButton value="yellow-cta">Amarelo</ToggleButton>
            <ToggleButton value="black-cta">Preto</ToggleButton>
          </ToggleButtonGroup>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Outlet />
      </Box>
    </Stack>
  );
}
