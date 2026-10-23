public class AccountValidation {
    public class ValidationException extends Exception {}
    public static void check(Account a) {
        if (a.Name == null) {
            throw new ValidationException('Name is required');
        }
    }
}
