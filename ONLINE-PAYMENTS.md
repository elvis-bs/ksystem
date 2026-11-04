# Pedidos online com pagamento em dinheiro

O cardápio digital aceita somente dinheiro na entrega ou na retirada. Não é necessário conectar banco, Mercado Pago ou outro meio de pagamento online.

## Publicação

1. No Supabase, execute `supabase-schema.sql` no **SQL Editor**, caso ainda não tenha feito isso.
2. Autorize a CLI na sua conta Supabase e associe este projeto:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   ```

   A autenticação acima autoriza a publicação de código no projeto Supabase; não é uma autenticação bancária e não conecta nenhuma conta de pagamento.

3. Publique a função que valida e registra os pedidos:

   ```powershell
   supabase functions deploy create-cash-order
   ```

4. Publique o site no GitHub Pages, entre no sistema e abra **Cardápio digital**.
5. Publique o catálogo, configure entrega e/ou retirada e ative **Aceitar pedidos online**. A finalização será liberada quando o servidor confirmar que aceita pedidos em dinheiro.
6. Faça um pedido de teste. Os pedidos são registrados como **Recebido**, e a loja cobra em dinheiro no recebimento.

## Funcionamento

- O cliente informa nome, telefone e endereço quando escolhe entrega.
- Para retirada, o cardápio apresenta o endereço da loja configurado pelo lojista.
- A função no servidor verifica a publicação, disponibilidade, preços, adicionais, endereço, taxa de entrega e limite de tentativas antes de gravar o pedido.
- O pedido online não atualiza o saldo do caixa; o pagamento deve ser registrado pela loja ao recebê-lo.
