/**
 * Internal design-token gallery — showcases theme buttons, cards, and inputs (not a production screen).
 */
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { appTitle } from "./appTitle.js";
import { MAIN_CONTENT_ID } from "./theme.js";

/**
 * Token preview page at `/galeria` for visual QA of the MUI theme.
 *
 * @returns Sample buttons, card, and text field using theme tokens (not a production attendant screen).
 */
export function Gallery() {
  return (
    <Container
      component="main"
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      maxWidth="sm"
      sx={{ py: 3, outline: "none" }}
    >
      <Typography component="h1" variant="h4" gutterBottom>
        {appTitle}
      </Typography>
      <Typography variant="body1" sx={{ mb: 3 }}>
        Galeria de tokens. Telas de produto devem usar o tema, não cores locais.
      </Typography>

      <Stack spacing={2} sx={{ mb: 3 }}>
        <Button variant="contained" color="primary">
          Ação principal
        </Button>
        <Button variant="contained" color="secondary">
          Orçamento
        </Button>
        <Button variant="contained" color="whatsapp">
          Enviar no WhatsApp
        </Button>
      </Stack>

      <Card sx={{ mb: 3 }} elevation={1}>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Cartão de exemplo
          </Typography>
          <Typography variant="body2">
            Cartões usam o raio médio do tema e a elevação Material 3.
          </Typography>
        </CardContent>
      </Card>

      <Stack spacing={2}>
        <TextField label="Nome" fullWidth autoComplete="off" />
        <Typography variant="caption">
          Toque ou tabule até o campo Nome para ver o estado de foco.
        </Typography>
        <TextField
          label="Placa"
          fullWidth
          error
          helperText="Placa inválida"
          defaultValue="ABC"
          autoComplete="off"
        />
      </Stack>
    </Container>
  );
}
