/**
 * MUI palette augmentation for brand tokens defined in {@link createAppTheme}.
 */
import type { PaletteColor, PaletteColorOptions } from "@mui/material/styles";

declare module "@mui/material/styles" {
  interface Palette {
    whatsapp: PaletteColor;
    surfaceVariant: string;
    readTick: string;
    primaryContainer: string;
    onPrimaryContainer: string;
    secondaryContainer: string;
    onSecondaryContainer: string;
    tertiary: string;
    onTertiary: string;
    tertiaryContainer: string;
    onTertiaryContainer: string;
    successContainer: string;
    onSuccessContainer: string;
    errorContainer: string;
    onErrorContainer: string;
    warningContainer: string;
    onWarningContainer: string;
    infoContainer: string;
    onInfoContainer: string;
  }

  interface PaletteOptions {
    whatsapp?: PaletteColorOptions;
    surfaceVariant?: string;
    readTick?: string;
    primaryContainer?: string;
    onPrimaryContainer?: string;
    secondaryContainer?: string;
    onSecondaryContainer?: string;
    tertiary?: string;
    onTertiary?: string;
    tertiaryContainer?: string;
    onTertiaryContainer?: string;
    successContainer?: string;
    onSuccessContainer?: string;
    errorContainer?: string;
    onErrorContainer?: string;
    warningContainer?: string;
    onWarningContainer?: string;
    infoContainer?: string;
    onInfoContainer?: string;
  }
}

declare module "@mui/material/styles/createPalette" {
  interface Palette {
    whatsapp: PaletteColor;
    surfaceVariant: string;
    readTick: string;
    primaryContainer: string;
    onPrimaryContainer: string;
    secondaryContainer: string;
    onSecondaryContainer: string;
    tertiary: string;
    onTertiary: string;
    tertiaryContainer: string;
    onTertiaryContainer: string;
    successContainer: string;
    onSuccessContainer: string;
    errorContainer: string;
    onErrorContainer: string;
    warningContainer: string;
    onWarningContainer: string;
    infoContainer: string;
    onInfoContainer: string;
  }

  interface PaletteOptions {
    whatsapp?: PaletteColorOptions;
    surfaceVariant?: string;
    readTick?: string;
    primaryContainer?: string;
    onPrimaryContainer?: string;
    secondaryContainer?: string;
    onSecondaryContainer?: string;
    tertiary?: string;
    onTertiary?: string;
    tertiaryContainer?: string;
    onTertiaryContainer?: string;
    successContainer?: string;
    onSuccessContainer?: string;
    errorContainer?: string;
    onErrorContainer?: string;
    warningContainer?: string;
    onWarningContainer?: string;
    infoContainer?: string;
    onInfoContainer?: string;
  }
}

declare module "@mui/material/Button" {
  interface ButtonPropsColorOverrides {
    whatsapp: true;
  }
}

declare module "@mui/material/Button/Button" {
  interface ButtonPropsColorOverrides {
    whatsapp: true;
  }
}
