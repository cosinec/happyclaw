import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Bug,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
  UserCog,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth';
import { getNativeBridge, nativeAnchoredMenu } from '../../native/bridge';
import type { MenuItemDeclaration } from '../../native/protocol';
import { useTheme, type ColorScheme, type Theme } from '../../hooks/useTheme';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

// Swatches show each scheme's primary so the choice is recognisable.
const SCHEME_OPTIONS: { value: ColorScheme; label: string; swatch: string }[] =
  [
    { value: 'default', label: '经典绿', swatch: '#0d9488' },
    { value: 'orange', label: '暖橙', swatch: 'oklch(0.646 0.222 41.116)' },
    { value: 'neutral', label: '素白', swatch: '#52525b' },
  ];

function AppearanceItems() {
  const { theme, colorScheme, setTheme, setColorScheme } = useTheme();
  return (
    <>
      <DropdownMenuLabel>主题</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => setTheme(value as Theme)}
      >
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>配色</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={colorScheme}
        onValueChange={(value) => setColorScheme(value as ColorScheme)}
      >
        {SCHEME_OPTIONS.map(({ value, label, swatch }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <span
                className="size-3 rounded-full ring-1 ring-foreground/10"
                style={{ backgroundColor: swatch }}
              />
            </span>
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

interface AccountMenuItemsProps {
  onReportBug: () => void;
  /** Phones render appearance inline: side submenus don't fit 390px. */
  inlineAppearance?: boolean;
  /** Mobile has no 用量 tab, so the menu links to it. */
  showUsage?: boolean;
}

/** Account menu body shared by the desktop sidebar and the mobile header. */
export function AccountMenuItems({
  onReportBug,
  inlineAppearance = false,
  showUsage = false,
}: AccountMenuItemsProps) {
  const navigate = useNavigate();
  return (
    <>
      <DropdownMenuItem onClick={() => navigate('/settings?tab=profile')}>
        <UserCog />
        个人设置
      </DropdownMenuItem>
      {showUsage && (
        <DropdownMenuItem onClick={() => navigate('/usage')}>
          <BarChart3 />
          用量统计
        </DropdownMenuItem>
      )}
      {inlineAppearance ? (
        <>
          <DropdownMenuSeparator />
          <AppearanceItems />
          <DropdownMenuSeparator />
        </>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette />
            外观
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-40">
            <AppearanceItems />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem onClick={onReportBug}>
        <Bug />
        报告问题
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onClick={async () => {
          await useAuthStore.getState().logout();
          navigate('/login');
        }}
      >
        <LogOut />
        退出登录
      </DropdownMenuItem>
    </>
  );
}

const THEME_SYMBOLS: Record<Theme, string> = {
  light: 'sun.max',
  dark: 'moon',
  system: 'circle.lefthalf.filled',
};

/**
 * The account menu as a native iOS menu, opened from the avatar. Returns an
 * opener that reports whether the shell took over; when it returns false the
 * caller opens the web dropdown as before. Items and actions match
 * AccountMenuItems (inline appearance).
 */
export function useNativeAccountMenu({
  onReportBug,
  showUsage = false,
}: Pick<AccountMenuItemsProps, 'onReportBug' | 'showUsage'>) {
  const navigate = useNavigate();
  const { theme, colorScheme, setTheme, setColorScheme } = useTheme();

  return (anchor: Element, title: string | null = null): boolean => {
    if (!getNativeBridge()?.supports('anchoredmenu')) return false;
    const items: MenuItemDeclaration[] = [
      {
        id: 'account',
        title: '',
        inline: true,
        children: [
          { id: 'profile', title: '个人设置', symbol: 'person.crop.circle' },
          ...(showUsage
            ? [{ id: 'usage', title: '用量统计', symbol: 'chart.bar' }]
            : []),
        ],
      },
      {
        id: 'theme',
        title: '主题',
        inline: true,
        children: THEME_OPTIONS.map(({ value, label }) => ({
          id: `theme:${value}`,
          title: label,
          symbol: THEME_SYMBOLS[value],
          checked: theme === value,
        })),
      },
      {
        id: 'scheme',
        title: '配色',
        inline: true,
        children: SCHEME_OPTIONS.map(({ value, label }) => ({
          id: `scheme:${value}`,
          title: label,
          checked: colorScheme === value,
        })),
      },
      {
        id: 'support',
        title: '',
        inline: true,
        children: [{ id: 'bug', title: '报告问题', symbol: 'ladybug' }],
      },
      {
        id: 'logout',
        title: '退出登录',
        symbol: 'rectangle.portrait.and.arrow.right',
        destructive: true,
      },
    ];

    void nativeAnchoredMenu(anchor, items, title).then(async (selected) => {
      if (!selected) return;
      if (selected === 'profile') navigate('/settings?tab=profile');
      else if (selected === 'usage') navigate('/usage');
      else if (selected === 'bug') onReportBug();
      else if (selected.startsWith('theme:'))
        setTheme(selected.slice('theme:'.length) as Theme);
      else if (selected.startsWith('scheme:'))
        setColorScheme(selected.slice('scheme:'.length) as ColorScheme);
      else if (selected === 'logout') {
        await useAuthStore.getState().logout();
        navigate('/login');
      }
    });
    return true;
  };
}
