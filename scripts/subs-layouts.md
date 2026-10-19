# Subscriptions: three layouts at phone width (390px)

The surface now has four kinds of row: subscriptions (the hero counts these),
bills, transfers and savings, and ended. Every option keeps the what-if-cancel
hero: tick rows and the monthly number drops to show the saving.

## A. One ledger, four drawers (chosen)

```
+------------------------------------+
| Subscriptions        [Mo|Yr]   (R) |
| $1,519 /mo     ~~$1,661~~          |
| 23 live . next 30 days $1,323      |
| Cancel 2: save $142/mo  clear      |
| Bills $7,740/mo . Transfers $2,541 |
+------------------------------------+
| [What to cut] [Overlaps 11] [+ Add]|
+------------------------------------+
| search.............  [Monthly] [v] |
+------------------------------------+
| v Subscriptions  23       $1,519/mo|
| [ ] (AC) Anthropic (Claude) $208/mo|
|          monthly . ..2999 . Oct 6  |
|          overlaps Grok             |
| [ ] (G)  Google Workspace    $42/mo|
|          3 descriptors . ..2999    |
|  ...                     1-10 of 23|
| > Bills  6                $7,740/mo|
| > Transfers & savings 8   $2,541/mo|
| > Ended  27          not in totals |
+------------------------------------+
| By service  (donut)                |
| List | Calendar                    |
+------------------------------------+
```

Rows are two lines: name and $/mo on top, then cadence, card, next charge and
at most one flag. The tick box and the row are 44px targets; work-card and
dismiss move into the detail sheet, so nothing small sits beside the amount.
Collapsed drawers still show their subtotal, so the whole money picture fits on
one screen without opening anything.

## B. Segmented tabs, card per service

```
+------------------------------------+
| $1,519 /mo  hero + what-if         |
+------------------------------------+
| [Subs 23][Bills 6][Xfer 8][Ended]  |
+------------------------------------+
| +--------------------------------+ |
| | (AC) Anthropic (Claude)        | |
| | $208/mo   $2,500/yr            | |
| | ..2999 . next Oct 6            | |
| | [ ] what if   [work] [x]       | |
| +--------------------------------+ |
| +--------------------------------+ |
| | (G) Google Workspace  ...      | |
```

Roomy and clear per row, but only one group is visible at a time: bills and
transfers drop out of sight behind a tab, and a card per row costs ~3x the
height of A, so 23 subscriptions are 8 screens of scrolling.

## C. Charge timeline

```
+------------------------------------+
| $1,519 /mo  hero + what-if         |
+------------------------------------+
| This week                    $253  |
|  Oct 20  Verizon wireless    $139  |
|  Oct 22  Zoom                 $54  |
| Next week                    $311  |
|  ...                               |
| [filter: Subs Bills Xfer]  Ended > |
+------------------------------------+
```

Answers "what hits my card next" well, but buries the per-service picture (an
annual fee shows up once a year), mixes bills into the subscription story, and
the calendar view already covers this job.

## Why A

The owner checks this on his phone to answer "what am I paying for and what can
I cut". A shows every group's subtotal at once, keeps the hero list first and
open, and folds the rest away so it stays tidy as rows are added. It reuses the
existing toolbar, pager and calendar, and it is the densest of the three without
shrinking tap targets.
