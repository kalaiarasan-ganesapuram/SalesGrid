public class AccountService {
    public static void enrich(List<Account> accounts) {
        for (Account a : accounts) {
            List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :a.Id];
            AccountValidation.check(a);
        }
    }
}
