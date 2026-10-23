/**
 * Handler for SalesGridDemoTrigger: fills a description before save, then
 * after save counts related contacts and checks each name, catching the
 * error it raises for a name containing "error".
 */
public with sharing class SalesGridDemoTriggerHandler {

    public class DemoValidationException extends Exception {}

    public static void beforeSave(List<Account> accounts) {
        for (Account acc : accounts) {
            acc.Description = 'Created by the Sales Grid demo';
            System.debug('Before save: ' + acc.Name);
        }
    }

    public static void afterSave(List<Account> accounts) {
        Set<Id> ids = new Map<Id, Account>(accounts).keySet();
        Integer contacts = [SELECT COUNT() FROM Contact WHERE AccountId IN :ids];
        System.debug('Contacts on these accounts: ' + contacts);

        for (Account acc : accounts) {
            try {
                checkName(acc);
                System.debug('Name is fine: ' + acc.Name);
            } catch (DemoValidationException e) {
                System.debug(LoggingLevel.ERROR, 'Caught for ' + acc.Name + ': ' + e.getMessage());
            }
        }
    }

    private static void checkName(Account acc) {
        if (acc.Name.containsIgnoreCase('error')) {
            throw new DemoValidationException('Name must not contain "error": ' + acc.Name);
        }
    }
}
