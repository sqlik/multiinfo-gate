<?php
declare(strict_types=1);

// Klient HTTP API bramki. Każda metoda to jedno wywołanie curl z nagłówkiem
// Authorization: Bearer. Błąd bramki (4xx/5xx) zamienia się w GateException,
// błąd sieci również - kod 'network' w polu gateCode (własność code jest zajęta
// przez wbudowany Exception). Bez Composera, bez zależności.

final class GateException extends RuntimeException
{
    public function __construct(
        public readonly string $gateCode,
        string $message,
        public readonly int $httpStatus,
        public readonly ?int $providerCode = null,
    ) {
        parent::__construct($message);
    }
}

final class MultiinfoGate
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $apiKey,
        private readonly int $timeoutS = 15,
    ) {
    }

    /** Pojedynczy SMS. Zwraca odpowiedź 202: id, status, encoding, parts, characters, slots. */
    public function sendMessage(string $to, string $text, ?string $orig = null, ?string $serviceId = null): array
    {
        $body = ['to' => $to, 'text' => $text];
        if ($orig !== null && $orig !== '') {
            $body['orig'] = $orig;
        }
        if ($serviceId !== null && $serviceId !== '') {
            $body['serviceId'] = $serviceId;
        }
        return $this->call('POST', '/v1/messages', $body);
    }

    public function getMessage(string $id): array
    {
        return $this->call('GET', '/v1/messages/' . rawurlencode($id));
    }

    public function cancelMessage(string $id): array
    {
        return $this->call('POST', '/v1/messages/' . rawurlencode($id) . '/cancel');
    }

    /**
     * Rozsyłka. $recipients: lista ['to' => numer, 'text' => treść własna (opcjonalnie), 'clientId' => (opcjonalnie)].
     * Treść domyślna dotyczy odbiorców bez własnej.
     */
    public function createPackage(array $recipients, string $defaultText, ?string $orig = null, ?string $serviceId = null): array
    {
        $body = ['recipients' => array_values($recipients), 'defaultText' => $defaultText];
        if ($orig !== null && $orig !== '') {
            $body['orig'] = $orig;
        }
        if ($serviceId !== null && $serviceId !== '') {
            $body['serviceId'] = $serviceId;
        }
        return $this->call('POST', '/v1/packages', $body);
    }

    public function getPackage(string $id): array
    {
        return $this->call('GET', '/v1/packages/' . rawurlencode($id));
    }

    /** Ponowne zamówienie raportu - bramka zamawia go sama po zakończeniu rozsyłki. */
    public function orderReport(string $id): array
    {
        return $this->call('POST', '/v1/packages/' . rawurlencode($id) . '/report');
    }

    /** Raport jako CSV (średnik). Gdy raport nie jest gotowy - GateException z kodem report_not_ready. */
    public function downloadReport(string $id): string
    {
        return $this->call('GET', '/v1/packages/' . rawurlencode($id) . '/report?format=csv', null, true);
    }

    private function call(string $method, string $path, ?array $body = null, bool $raw = false): array|string
    {
        $ch = curl_init($this->baseUrl . $path);
        if ($ch === false) {
            throw new GateException('network', 'Nie udało się zainicjować curl.', 0);
        }
        $headers = [
            'Authorization: Bearer ' . $this->apiKey,
            'Accept: ' . ($raw ? 'text/csv' : 'application/json'),
        ];
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutS,
        ];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        }
        $options[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $options);

        $response = curl_exec($ch);
        if ($response === false) {
            $error = curl_error($ch);
            throw new GateException('network', "Brak połączenia z bramką: $error", 0);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if ($status >= 400) {
            $decoded = json_decode((string) $response, true);
            $error = is_array($decoded) ? ($decoded['error'] ?? []) : [];
            throw new GateException(
                (string) ($error['code'] ?? "http_$status"),
                (string) ($error['message'] ?? "Bramka odpowiedziała kodem $status."),
                $status,
                isset($error['providerCode']) ? (int) $error['providerCode'] : null,
            );
        }
        if ($raw) {
            return (string) $response;
        }
        $decoded = json_decode((string) $response, true);
        if (!is_array($decoded)) {
            throw new GateException('bad_response', 'Bramka odpowiedziała czymś, co nie jest JSON-em.', $status);
        }
        return $decoded;
    }
}
