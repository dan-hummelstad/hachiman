import {
  FileText,
  Folder,
  Hash,
  Users,
  Volume2,
  type LucideIcon,
  type LucideProps
} from 'lucide-react'
import type { ChannelType } from '@hachiman/client'

const ICONS: Record<ChannelType, LucideIcon> = {
  text: Hash,
  voice: Volume2,
  pages: FileText,
  category: Folder,
  dm: Users,
  group_dm: Users
}

/** The glyph of a channel type: sidebar rows, the title bar and the create dialog. */
export function ChannelIcon({
  type,
  ...props
}: { type: ChannelType } & LucideProps): React.JSX.Element {
  const Icon = ICONS[type]
  return <Icon {...props} />
}
