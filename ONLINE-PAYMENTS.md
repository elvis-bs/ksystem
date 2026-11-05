# Pedidos online com Pix

O cardápio digital aceita dinheiro na entrega ou retirada e Pix online pelo Mercado Pago. O pedido pago por Pix só passa de **Aguardando Pix** para **Recebido** após a confirmação do Mercado Pago.

## Pré-requisitos do Mercado Pago

Configure no projeto Supabase os secrets já usados pela integração:

- `MP_CLIENT_ID`
- `MP_CLIENT_SECRET`
- `MP_OAUTH_REDIRECT_URI`: URL da função `mercadopago-oauth-callback` deste projeto Supabase.
- `MP_OAUTH_APP_URL`: URL publicada do Bora! Gestão para onde o cliente volta após autorizar a conta.
- `MP_WEBHOOK_SECRET`: chave secreta de assinatura do webhook de pagamentos configurado no painel da aplicação Mercado Pago.
- `MP_TEST_MODE`: `true` para credenciais de teste; `false` para produção.

Não coloque essas credenciais no código nem no cardápio público. Cadastre a mesma URL de callback nas configurações OAuth da aplicação Mercado Pago e configure o evento de pagamentos para usar a função `mercadopago-webhook`.

## Atualização do banco e funções

1. Execute `supabase-schema.sql` no **SQL Editor** do Supabase, caso ainda não tenha aplicado o esquema de pagamentos.
2. No terminal, autorize e associe a CLI ao projeto:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   ```

3. Publique as funções:

   ```powershell
   supabase functions deploy create-cash-order
   supabase functions deploy mercadopago-settings
   supabase functions deploy mercadopago-oauth-callback
   supabase functions deploy mercadopago-webhook
   supabase functions deploy check-pix-order
   ```

4. Publique o site no GitHub Pages e entre no Bora! Gestão.
5. Abra **Cardápio digital** e clique em **Conectar conta Mercado Pago**. Autorize a conta que receberá os pagamentos.
6. Publique o cardápio e ative **Aceitar pedidos online**.

## Como o Pix funciona

- O cliente escolhe Pix online no checkout, informa um e-mail e recebe o QR Code e o código Pix copia e cola.
- O servidor valida produtos, adicionais, taxa, total e disponibilidade antes de criar a cobrança Pix no Mercado Pago.
- O cardápio consulta o status do pagamento; o webhook também atualiza o pedido. Apenas pagamentos aprovados são marcados como recebidos.
- O pedido online não atualiza o caixa automaticamente; registre o recebimento no sistema conforme o fluxo financeiro da loja.
- Para usar somente dinheiro, não é necessário conectar o Mercado Pago.
