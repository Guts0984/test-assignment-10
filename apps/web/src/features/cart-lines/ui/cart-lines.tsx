'use client';
import { Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { CartLineDto } from '@shop/shared';
import { usePutCartItem, useRemoveCartItem } from '@/entities/cart';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import { Button, Input, Table, TBody, TD, TH, THead, TR } from '@/shared/ui';

function QtyInput({ line }: { line: CartLineDto }) {
  const t = useTranslations('cart');
  const put = usePutCartItem();
  const [value, setValue] = useState(String(line.qty));
  useEffect(() => setValue(String(line.qty)), [line.qty]);

  const commit = () => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 999 && n !== line.qty)
      put.mutate({ productId: line.productId, qty: n });
    else setValue(String(line.qty));
  };
  return (
    <Input
      aria-label={t('quantityOf', { name: line.name })}
      className="w-20"
      type="number"
      min={1}
      max={999}
      inputMode="numeric"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

export function CartLines({ lines }: { lines: CartLineDto[] }) {
  const t = useTranslations('cart');
  const locale = useLocale() as Locale;
  const remove = useRemoveCartItem();
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t('product')}</TH>
          <TH>{t('price')}</TH>
          <TH>{t('qty')}</TH>
          <TH className="text-right">{t('sum')}</TH>
          <TH>
            <span className="sr-only">{t('remove')}</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {lines.map((l) => (
          <TR key={l.productId} data-testid="cart-line">
            <TD>
              <div className="font-medium">{l.name}</div>
              {l.inactive ? (
                <p className="text-xs text-destructive">{t('unavailable')}</p>
              ) : l.insufficientStock ? (
                <p className="text-xs text-destructive">{t('onlyLeft', { count: l.available })}</p>
              ) : null}
            </TD>
            <TD>
              {formatMoney(l.unitPrice, locale)}
              {l.priceChanged ? (
                <div className="text-xs text-warning-foreground">
                  {t('priceWas', { price: formatMoney(l.priceSeen, locale) })}
                </div>
              ) : null}
            </TD>
            <TD>{l.inactive ? '—' : <QtyInput line={l} />}</TD>
            <TD className="text-right font-medium">{formatMoney(l.subtotal, locale)}</TD>
            <TD>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('removeItem', { name: l.name })}
                disabled={remove.isPending}
                onClick={() => remove.mutate(l.productId)}
              >
                <Trash2 aria-hidden className="h-4 w-4" />
              </Button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
