import type { InstallerProfile } from '@shared/manifest'

export interface InstallerProfileInfo {
  id: InstallerProfile
  label: string
  description: string
  /** Solo informativo: el perfil no añade ni cambia argumentos. */
  silentArgumentHint?: string
  /** El MVP no mata procesos de setup; la cancelación segura depende del instalador. */
  cancellation: 'unsafe-by-default'
}

export const INSTALLER_PROFILE_INFO: Record<InstallerProfile, InstallerProfileInfo> = {
  generic: {
    id: 'generic',
    label: 'Genérico',
    description:
      'Ejecuta el setup con los argumentos exactos del manifiesto y espera su salida. Después verifica los archivos declarados.',
    cancellation: 'unsafe-by-default'
  },
  inno: {
    id: 'inno',
    label: 'Inno Setup',
    description:
      'Perfil informativo para instaladores Inno Setup. Los argumentos silenciosos deben estar verificados y escritos en el manifiesto.',
    silentArgumentHint: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="{installDir}"',
    cancellation: 'unsafe-by-default'
  },
  nsis: {
    id: 'nsis',
    label: 'NSIS',
    description:
      'Perfil informativo para instaladores NSIS. No se añade /S automáticamente: debe estar en los argumentos solo si el instalador lo admite.',
    silentArgumentHint: '/S /D=<ruta> (las reglas de NSIS varían; verifica cada instalador)',
    cancellation: 'unsafe-by-default'
  },
  demo: {
    id: 'demo',
    label: 'Demo verificada',
    description:
      'Instalador de demostración propio. Admite /S y /DIR y escribe archivos de verificación. No representa a instaladores de terceros.',
    silentArgumentHint: '/S /DIR={installDir}',
    cancellation: 'unsafe-by-default'
  }
}
