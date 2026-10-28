import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Brain,
  Wallet,
  Settings,
} from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
  /** iOS shell placement: a tab-bar slot or the 「更多」 list (SF Symbol). */
  native: { placement: 'tab' | 'more'; symbol: string };
}

export const baseNavItems: NavItem[] = [
  {
    path: '/chat',
    icon: MessageCircle,
    label: '工作台',
    native: { placement: 'tab', symbol: 'bubble.left.and.bubble.right' },
  },
  {
    path: '/agent-profiles',
    icon: Bot,
    label: '智能体',
    native: { placement: 'tab', symbol: 'person.crop.circle' },
  },
  {
    path: '/capabilities',
    icon: Puzzle,
    label: '能力库',
    native: { placement: 'tab', symbol: 'puzzlepiece.extension' },
  },
  {
    path: '/tasks',
    icon: Clock4,
    label: '任务',
    native: { placement: 'tab', symbol: 'clock' },
  },
  {
    path: '/usage',
    icon: BarChart3,
    label: '用量',
    hideOnMobile: true,
    native: { placement: 'more', symbol: 'chart.bar' },
  },
  {
    path: '/memory',
    icon: Brain,
    label: '记忆',
    hideOnMobile: true,
    native: { placement: 'more', symbol: 'brain' },
  },
  {
    path: '/billing',
    icon: Wallet,
    label: '账单',
    requiresBilling: true,
    native: { placement: 'more', symbol: 'creditcard' },
  },
  {
    path: '/settings',
    icon: Settings,
    label: '设置',
    native: { placement: 'more', symbol: 'gearshape' },
  },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => !item.requiresBilling || billingEnabled);
}
