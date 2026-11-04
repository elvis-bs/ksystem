# Pedidos online com pagamento em dinheiro

O cardápio digital aceita pedidos pagos somente em dinheiro na entrega ou retirada. A conexão com o Mercado Pago não é necessária para esse fluxo; as instruções de OAuth abaixo são opcionais e mantêm a integração disponível para outros recursos do sistema.

## Configuração do recebimento em dinheiro

1. No Supabase, abra **SQL Editor** e execute o arquivo `supabase-schema.sql` atualizado. Ele acrescenta tabelas para pedidos online, sem substituir os dados existentes de `business_data`.
2. Na raiz do projeto, publique a função de pedidos:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   supabase functions deploy create-pix-order
   ```

3. Publique a versão atualizada do site no GitHub Pages e entre no sistema.
4. Em **Cardápio digital**, publique o catálogo para gerar e copiar o link. Configure a taxa de entrega e, se disponível, o endereço para retirada. Habilite **Aceitar pedidos online** depois que o servidor anunciar suporte a dinheiro. O cliente pagará em dinheiro na entrega ou retirada; pedidos chegam à loja como **Recebido**. Faça um pedido de teste antes de compartilhar o cardápio.

## Integração opcional com Mercado Pago

Esses passos não são necessários para receber pedidos pagos em dinheiro.

1. No Mercado Pago Developers, crie uma aplicação para Checkout Transparente e configure:
   - **URL de retorno OAuth**: `https://jnqwtqixklmuxaeppkry.supabase.co/functions/v1/mercadopago-oauth-callback`
   - **Notificações/Webhooks** para eventos de pagamento (`payment`): `https://jnqwtqixklmuxaeppkry.supabase.co/functions/v1/mercadopago-webhook`
   - Copie o ID e o segredo da aplicação, além do segredo de assinatura dos Webhooks.
2. Para testar, no painel da aplicação Mercado Pago abra **Contas de teste** e crie/seleciona uma conta vendedora e uma compradora de teste. A documentação do Mercado Pago indica que o fluxo OAuth precisa do ID e segredo da aplicação; o token de sandbox é gerado pelo servidor com `test_token=true`. **Não use nem cole o Access Token de teste**: este fluxo OAuth não lê `MP_ACCESS_TOKEN`.
3. No Supabase Dashboard, abra **Edge Functions → Secrets** e configure:
   - `MP_CLIENT_ID`: ID da aplicação Mercado Pago.
   - `MP_CLIENT_SECRET`: segredo da aplicação.
   - `MP_WEBHOOK_SECRET`: segredo de assinatura dos Webhooks.
   - `MP_OAUTH_REDIRECT_URI`: a URL de retorno OAuth acima, exatamente como cadastrada no Mercado Pago.
   - `MP_OAUTH_APP_URL`: URL pública da página do sistema, por exemplo `https://<usuario>.github.io/<repositorio>/`. Use a URL real do Bora! Gestão, sem parâmetros de consulta.
   - `MP_TEST_MODE`: `true` para solicitar tokens de sandbox; não configure ou use `false` para produção.

   As credenciais de teste _Public Key/Access Token_ da tela **Credenciais → Teste** não são usadas neste fluxo OAuth. O ID/segredo da aplicação ficam exclusivamente nos Secrets do Supabase. Não os coloque em `index.html`, `business_data` ou no Git.
4. Na raiz do projeto, publique as funções:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   supabase functions deploy create-pix-order
   supabase functions deploy check-pix-order
   supabase functions deploy mercadopago-webhook
   supabase functions deploy mercadopago-settings
   supabase functions deploy mercadopago-oauth-callback
   ```

5. Abra **Pagamentos online → Conectar Mercado Pago**. Em teste, entre com a conta vendedora de teste e autorize o Bora! Gestão. A tela deve indicar **Conectado · Teste**.

## Segurança e funcionamento

- As chaves da aplicação e do webhook permanecem nos Secrets do Supabase. O token de cada vendedor é obtido por OAuth e mantido no banco numa tabela sem acesso para `anon` ou `authenticated`; apenas funções de servidor podem ler ou renovar esses tokens.
- O fluxo OAuth valida `state`, usa PKCE, expira tentativas pendentes após 10 minutos e troca tokens no servidor. Os tokens de renovação são atualizados automaticamente.
- O preço e a taxa de entrega são recalculados no servidor; o total enviado pelo navegador não é confiável.
- A publicação do catálogo é independente da opção de aceitar pedidos. O link pode exibir produtos e preços sem habilitar a finalização; a Edge Function rejeita pedidos quando `acceptingOrders` está desativado no menu publicado.
- A Edge Function recalcula preços e taxas e valida os itens antes de registrar cada pedido.
- O pagamento em dinheiro na entrega/retirada não é processado online: a loja recebe o pedido e cobra no recebimento. O cardápio só libera a finalização após a Edge Function anunciar suporte a dinheiro.
- Pedidos online pagos aparecem em **Vendas e pedidos** e **Acompanhar pedidos**. Eles não alteram o saldo em dinheiro do caixa.

Referências oficiais: [OAuth do Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation), [renovação OAuth](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/renewal), [Pix no Checkout Transparente](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/websites/pix), [criação de pagamentos](https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post), [Webhooks](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks) e [Secrets das Supabase Edge Functions](https://supabase.com/docs/guides/functions/secrets).
