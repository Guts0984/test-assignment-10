'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import type { ProductDto } from '@shop/shared';
import { useCategories, useCreateProduct, useUpdateProduct } from '@/entities/product';
import { isApiError } from '@/shared/api/client';
import { toMoneyInput } from '@/shared/lib/format';
import { Alert, Button, Field, Input } from '@/shared/ui';
import { Select } from '@/shared/ui/input';
import { productFormSchema, toProductPayload, type ProductFormValues } from '../model/schema';

export function ProductForm({ product, onDone }: { product?: ProductDto; onDone: () => void }) {
  const t = useTranslations('manager.products');
  const tv = useTranslations('validation');
  const tc = useTranslations('common');
  const categories = useCategories();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: product
      ? {
          name: product.name,
          categoryId: product.categoryId,
          price: toMoneyInput(product.price),
          stock: String(product.stock),
          active: product.active,
        }
      : { name: '', categoryId: '', price: '', stock: '0', active: true },
  });
  const m = product ? update : create;
  const msg = (k?: string) => (k ? tv(k as 'required') : undefined);

  return (
    <form
      noValidate
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
      aria-label={product ? t('editing') : t('creating')}
      onSubmit={handleSubmit((v) => {
        const body = toProductPayload(v);
        if (product) update.mutate({ id: product.id, body }, { onSuccess: onDone });
        else create.mutate(body, { onSuccess: onDone });
      })}
    >
      <h2 className="font-semibold sm:col-span-2">{product ? t('editing') : t('creating')}</h2>
      {m.isError ? (
        <Alert tone="danger" className="sm:col-span-2">
          {isApiError(m.error) && m.error.status === 400 ? tc('error') : tc('error')}
        </Alert>
      ) : null}
      <Field
        id="p-name"
        label={t('name')}
        error={msg(errors.name?.message)}
        className="sm:col-span-2"
      >
        {(a) => <Input {...a} {...register('name')} />}
      </Field>
      <Field id="p-category" label={t('category')} error={msg(errors.categoryId?.message)}>
        {(a) => (
          <Select {...a} {...register('categoryId')}>
            <option value="">—</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="p-price" label={t('price')} error={msg(errors.price?.message)}>
        {(a) => <Input {...a} inputMode="decimal" {...register('price')} />}
      </Field>
      <Field id="p-stock" label={t('stock')} error={msg(errors.stock?.message)}>
        {(a) => <Input {...a} inputMode="numeric" {...register('stock')} />}
      </Field>
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" {...register('active')} />
        {t('active')}
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={m.isPending}>
          {tc('save')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}
