# Ativação de pedidos online com Pix

Cada loja conecta a própria conta Mercado Pago pela aba **Pagamentos online**. A autorização OAuth acontece no Mercado Pago; os tokens de acesso e renovação ficam numa tabela acessível somente às Edge Functions com a chave `service_role`. Eles não são enviados ao navegador nem gravados nos dados normais da loja.

## Configuração inicial (uma vez por aplicação)

1. No Supabase, abra **SQL Editor** e execute o arquivo `supabase-schema.sql` atualizado. Ele acrescenta tabelas para conexões OAuth e pedidos online, sem substituir os dados existentes de `business_data`.
2. No Mercado Pago Developers, crie uma aplicação para Checkout Transparente e configure:
   - **URL de retorno OAuth**: `https://jnqwtqixklmuxaeppkry.supabase.co/functions/v1/mercadopago-oauth-callback`
   - **Notificações/Webhooks** para eventos de pagamento (`payment`): `https://jnqwtqixklmuxaeppkry.supabase.co/functions/v1/mercadopago-webhook`
   - Copie o ID e o segredo da aplicação, além do segredo de assinatura dos Webhooks.
3. Para testar, no painel da aplicação Mercado Pago abra **Contas de teste** e crie/seleciona uma conta vendedora e uma compradora de teste. A documentação do Mercado Pago indica que o fluxo OAuth precisa do ID e segredo da aplicação; o token de sandbox é gerado pelo servidor com `test_token=true`. **Não use nem cole o Access Token de teste**: este fluxo OAuth não lê `MP_ACCESS_TOKEN`.
4. No Supabase Dashboard, abra **Edge Functions → Secrets** e configure:
   - `MP_CLIENT_ID`: ID da aplicação Mercado Pago.
   - `MP_CLIENT_SECRET`: segredo da aplicação.
   - `MP_WEBHOOK_SECRET`: segredo de assinatura dos Webhooks.
   - `MP_OAUTH_REDIRECT_URI`: a URL de retorno OAuth acima, exatamente como cadastrada no Mercado Pago.
   - `MP_OAUTH_APP_URL`: URL pública da página do sistema, por exemplo `https://<usuario>.github.io/<repositorio>/`. Use a URL real do Bora! Gestão, sem parâmetros de consulta.
   - `MP_TEST_MODE`: `true` para solicitar tokens de sandbox; não configure ou use `false` para produção.

   As credenciais de teste _Public Key/Access Token_ da tela **Credenciais → Teste** não são usadas neste fluxo OAuth. O ID/segredo da aplicação ficam exclusivamente nos Secrets do Supabase. Não os coloque em `index.html`, `business_data` ou no Git.
5. Na raiz do projeto, publique as funções:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   supabase functions deploy create-pix-order
   supabase functions deploy check-pix-order
   supabase functions deploy mercadopago-webhook
   supabase functions deploy mercadopago-settings
   supabase functions deploy mercadopago-oauth-callback
   ```

6. Publique a versão atualizada do site no GitHub Pages e entre no sistema.
7. Abra **Pagamentos online → Conectar Mercado Pago**. Em teste, entre com a conta vendedora de teste e autorize o Bora! Gestão. A tela deve indicar **Conectado · Teste**.
8. Em **Cardápio digital**, publique o catálogo para gerar e copiar o link, mesmo antes de concluir o Pix. Para receber pedidos online, conecte o Mercado Pago, configure taxa de entrega e retirada e habilite **Aceitar pedidos online com Pix**. Faça um pedido como a conta compradora de teste e confirme o Pix com os meios de teste disponíveis na conta.
9. Para produção, remova `MP_TEST_MODE` (ou defina `false`), confirme que o webhook de produção está configurado e reconecte a conta vendedora real em **Pagamentos online**. A tela deve indicar **Conectado · Produção** antes de aceitar pedidos reais.

## Segurança e funcionamento

- As chaves da aplicação e do webhook permanecem nos Secrets do Supabase. O token de cada vendedor é obtido por OAuth e mantido no banco numa tabela sem acesso para `anon` ou `authenticated`; apenas funções de servidor podem ler ou renovar esses tokens.
- O fluxo OAuth valida `state`, usa PKCE, expira tentativas pendentes após 10 minutos e troca tokens no servidor. Os tokens de renovação são atualizados automaticamente.
- O preço e a taxa de entrega são recalculados no servidor; o total enviado pelo navegador não é confiável.
- A publicação do catálogo é independente da opção de aceitar pedidos. Enquanto Pix não estiver configurado, o link exibe produtos e preços, mas não permite enviar pedidos; a Edge Function também rejeita pedidos quando `acceptingOrders` está desativado no menu publicado.
- O pedido fica como **Aguardando Pix** e só entra na fila de preparo após confirmação do pagamento. O webhook assinado é a confirmação principal; enquanto aberta, a tela do cliente também consulta o status.
- Pedidos online pagos aparecem em **Vendas e pedidos** e **Acompanhar pedidos**. Eles não alteram o saldo em dinheiro do caixa.

Referências oficiais: [OAuth do Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation), [renovação OAuth](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/renewal), [Pix no Checkout Transparente](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/websites/pix), [criação de pagamentos](https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post), [Webhooks](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks) e [Secrets das Supabase Edge Functions](https://supabase.com/docs/guides/functions/secrets).
